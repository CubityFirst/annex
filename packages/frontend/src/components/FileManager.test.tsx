import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { FileManager } from "./FileManager";
import { apiFetchJson } from "@/lib/apiFetch";

vi.mock("@/lib/apiFetch", () => ({
  apiFetchJson: vi.fn(),
  apiFetch: vi.fn(),
}));

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

// react-resizable-panels (inside ResizableTable) does `new ResizeObserver()`;
// the global setup mock is a plain vi.fn and not constructible.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

// The profile hovercard and avatar fetch on mount - irrelevant here.
vi.mock("@/components/UserProfileCard", () => ({
  UserProfileCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/UserAvatar", () => ({
  UserAvatar: () => <span data-testid="avatar" />,
}));

interface ContentsShape {
  folders: unknown[];
  docs: unknown[];
  files: unknown[];
  folderCounts: Record<string, unknown>;
  ancestors: unknown[];
}

const emptyContents: ContentsShape = { folders: [], docs: [], files: [], folderCounts: {}, ancestors: [] };

function doc(id: string, title: string) {
  return { id, title, folder_id: null, updated_at: "2026-01-01T00:00:00Z", author_id: "u1", author_name: "Ann" };
}

function folder(id: string, name: string) {
  return { id, name, project_id: "p1", parent_id: null, created_at: "2026-01-01T00:00:00Z" };
}

// The desktop table row (role="row") that contains the element labelled `label`.
function desktopRow(label: string) {
  const row = screen.getAllByLabelText(label).map(el => el.closest('[role="row"]')).find(Boolean);
  if (!row) throw new Error(`no table row for ${label}`);
  return row as HTMLElement;
}

function renderManager(folderId: string | null = null, myRole = "owner", headerActionSlot: HTMLElement | null = null) {
  const ctx = { setBreadcrumbs: vi.fn(), headerActionSlot };
  const utils = render(
    <MemoryRouter>
      <Routes>
        <Route element={<Outlet context={ctx} />}>
          <Route
            path="*"
            element={
              <FileManager
                projectId="p1"
                projectName="Site"
                folderId={folderId}
                myRole={myRole}
                onDocCreated={vi.fn()}
              />
            }
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  const rerenderWith = (nextFolderId: string | null) =>
    utils.rerender(
      <MemoryRouter>
        <Routes>
          <Route element={<Outlet context={ctx} />}>
            <Route
              path="*"
              element={
                <FileManager
                  projectId="p1"
                  projectName="Site"
                  folderId={nextFolderId}
                  myRole={myRole}
                  onDocCreated={vi.fn()}
                />
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  return { ...utils, rerenderWith };
}

beforeEach(() => {
  vi.mocked(apiFetchJson).mockReset();
});

describe("FileManager", () => {
  // FM-H2 regression: items checked in folder A must not stay silently
  // selected (and bulk-deletable) after navigating to folder B.
  it("clears selections when navigating to another folder", async () => {
    vi.mocked(apiFetchJson).mockImplementation(async (url: string) => {
      if (String(url).includes("/contents")) {
        const inFolderB = String(url).includes("folderId=B");
        return {
          ok: true,
          status: 200,
          data: inFolderB ? emptyContents : { ...emptyContents, docs: [doc("d1", "Doc A")] },
        };
      }
      return { ok: true, status: 200, data: emptyContents };
    });

    const { rerenderWith } = renderManager(null);
    const checkbox = (await screen.findAllByLabelText("Select Doc A"))[0];
    fireEvent.click(checkbox);
    expect(screen.getByLabelText("Delete 1 selected")).toBeTruthy();

    rerenderWith("B");
    await waitFor(() => expect(screen.queryByLabelText(/Delete \d+ selected/)).toBeNull());
  });

  // FM-H4 regression: a rejected rename must not apply locally or close the
  // dialog as if it had succeeded.
  it("keeps the old title and the dialog open when a rename fails", async () => {
    vi.mocked(apiFetchJson).mockImplementation(async (url: string, opts?: RequestInit) => {
      if (String(url).includes("/contents")) {
        return { ok: true, status: 200, data: { ...emptyContents, docs: [doc("d1", "Doc A")] } };
      }
      if (String(url) === "/api/docs/d1" && opts?.method === "PUT") {
        return { ok: false, status: 403, error: "Forbidden" };
      }
      return { ok: true, status: 200 };
    });

    renderManager(null);
    const pencil = (await screen.findAllByLabelText("Rename Doc A"))[0];
    fireEvent.click(pencil);
    const input = await screen.findByLabelText("Name");
    fireEvent.change(input, { target: { value: "Doc A renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() =>
      expect(vi.mocked(apiFetchJson).mock.calls.some(([u, o]) => u === "/api/docs/d1" && (o as RequestInit)?.method === "PUT")).toBe(true),
    );
    // Old title still listed, no optimistic apply...
    expect(screen.getAllByText("Doc A").length).toBeGreaterThan(0);
    expect(screen.queryByText("Doc A renamed")).toBeNull();
    // ...and the dialog stayed open for a retry.
    expect(screen.getByLabelText("Name")).toBeTruthy();
  });

  // FM-M4 regression: mutations made from search results must be reflected in
  // the visible (search) list, not just the hidden folder list.
  it("updates the visible search results after a successful rename", async () => {
    vi.mocked(apiFetchJson).mockImplementation(async (url: string, opts?: RequestInit) => {
      const u = String(url);
      if (u.includes("/contents")) {
        return { ok: true, status: 200, data: { ...emptyContents, docs: [doc("d1", "Alpha")] } };
      }
      if (u.startsWith("/api/docs?") && u.includes("q=alp")) {
        return { ok: true, status: 200, data: [doc("d1", "Alpha")] };
      }
      if (u === "/api/docs/d1" && opts?.method === "PUT") {
        return { ok: true, status: 200 };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderManager(null);
    await screen.findAllByText("Alpha");
    fireEvent.change(screen.getByLabelText("Search files and documents"), { target: { value: "alp" } });
    // Debounced search (250ms) - wait for the search-mode list.
    await waitFor(() => expect(vi.mocked(apiFetchJson).mock.calls.some(([u]) => String(u).startsWith("/api/docs?"))).toBe(true));

    const pencil = (await screen.findAllByLabelText("Rename Alpha"))[0];
    fireEvent.click(pencil);
    const input = await screen.findByLabelText("Name");
    fireEvent.change(input, { target: { value: "Alpha II" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() => expect(screen.getAllByText("Alpha II").length).toBeGreaterThan(0));
    expect(screen.queryByText("Alpha")).toBeNull();
  });

  // Folder rows must reserve the checkbox spacer the header reserves for
  // editors, or every folder cell sits one column (40px) to the left.
  it("aligns folder cells with the checkbox column for editors", async () => {
    vi.mocked(apiFetchJson).mockResolvedValue({
      ok: true, status: 200,
      data: { ...emptyContents, folders: [folder("f1", "Specs")], docs: [doc("d1", "Doc A")] },
    });
    renderManager(null);
    await screen.findAllByLabelText("Open folder Specs");
    const nameCol = (label: string) => desktopRow(label).querySelector('[data-col="0"]')!.getAttribute("aria-colindex");
    expect(nameCol("Open folder Specs")).toBe("2");
    expect(nameCol("Open Doc A")).toBe("2");
  });

  // A single-item delete must also leave the bulk selection, or the toolbar
  // keeps offering "Delete (1)" for a row that no longer exists.
  it("drops a doc deleted from its menu out of the bulk selection", async () => {
    vi.mocked(apiFetchJson).mockImplementation(async (url: string) => {
      if (String(url).includes("/contents")) {
        return { ok: true, status: 200, data: { ...emptyContents, docs: [doc("d1", "Doc A"), doc("d2", "Doc B")] } };
      }
      return { ok: true, status: 200 };
    });
    renderManager(null);
    fireEvent.click((await screen.findAllByLabelText("Select Doc A"))[0]);
    expect(screen.getByLabelText("Delete 1 selected")).toBeTruthy();

    fireEvent.keyDown(screen.getAllByLabelText("Actions for Doc A")[0], { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(vi.mocked(apiFetchJson).mock.calls.some(([u, o]) => u === "/api/docs/d1" && (o as RequestInit)?.method === "DELETE")).toBe(true),
    );
    await waitFor(() => expect(screen.queryByLabelText(/Delete \d+ selected/)).toBeNull());
  });

  const dataTransfer = () => ({ setData: vi.fn(), getData: vi.fn(), effectAllowed: "", types: ["text/plain"], files: [] });
  const putCalls = () => vi.mocked(apiFetchJson).mock.calls.filter(([, o]) => (o as RequestInit)?.method === "PUT");

  // Viewers can't move items - a drag would 403 after an optimistic removal
  // (or, for a doc-share editor, silently not move and vanish until reload).
  it("doesn't let viewers drag rows onto folders", async () => {
    vi.mocked(apiFetchJson).mockResolvedValue({
      ok: true, status: 200,
      data: { ...emptyContents, folders: [folder("f1", "Specs")], docs: [doc("d1", "Doc A")] },
    });
    renderManager(null, "viewer");
    await screen.findAllByLabelText("Open folder Specs");
    const docRow = desktopRow("Open Doc A");
    const folderRow = desktopRow("Open folder Specs");
    expect(docRow.getAttribute("draggable")).toBe("false");
    expect(folderRow.getAttribute("draggable")).toBe("false");

    fireEvent.dragStart(docRow, { dataTransfer: dataTransfer() });
    fireEvent.dragOver(folderRow, { dataTransfer: dataTransfer() });
    fireEvent.drop(folderRow, { dataTransfer: dataTransfer() });
    expect(putCalls()).toHaveLength(0);
    expect(screen.getAllByText("Doc A").length).toBeGreaterThan(0);
  });

  // The home doc is pinned to the site root - no drag, and a drag that
  // somehow starts must not move it.
  it("never moves the home doc by drag", async () => {
    vi.mocked(apiFetchJson).mockResolvedValue({
      ok: true, status: 200,
      data: { ...emptyContents, folders: [folder("f1", "Specs")], docs: [{ ...doc("h1", "Home"), is_home: 1 }] },
    });
    renderManager(null);
    await screen.findAllByLabelText("Open folder Specs");
    const homeRow = desktopRow("Open Home");
    expect(homeRow.getAttribute("draggable")).toBe("false");

    fireEvent.dragStart(homeRow, { dataTransfer: dataTransfer() });
    fireEvent.drop(desktopRow("Open folder Specs"), { dataTransfer: dataTransfer() });
    expect(putCalls()).toHaveLength(0);
    expect(screen.getAllByText("Home").length).toBeGreaterThan(0);
  });

  // Folder badges are subtree totals - a successful move into a listed folder
  // must show up there without a refetch.
  it("bumps the destination folder's badge after a drag move", async () => {
    vi.mocked(apiFetchJson).mockImplementation(async (url: string) => {
      if (String(url).includes("/contents")) {
        return {
          ok: true, status: 200,
          data: {
            ...emptyContents,
            folders: [folder("f1", "Specs"), folder("f2", "Drafts")],
            docs: [doc("d1", "Doc A")],
            folderCounts: { f1: { docs: 1, files: 0, folders: 0 }, f2: { docs: 2, files: 1, folders: 1 } },
          },
        };
      }
      return { ok: true, status: 200 };
    });
    renderManager(null);
    await screen.findAllByText("1 item");

    // Doc into Specs.
    fireEvent.dragStart(desktopRow("Open Doc A"), { dataTransfer: dataTransfer() });
    fireEvent.dragOver(desktopRow("Open folder Specs"), { dataTransfer: dataTransfer() });
    fireEvent.drop(desktopRow("Open folder Specs"), { dataTransfer: dataTransfer() });
    // Specs badge - desktop row and mobile card show the same total, with the
    // breakdown in the tooltip.
    await waitFor(() => expect(screen.getAllByText("2 items").length).toBe(2));
    expect(screen.getAllByTitle("2 docs").length).toBe(2);
    fireEvent.dragEnd(desktopRow("Open folder Specs"));

    // Drafts (with its whole subtree) into Specs.
    fireEvent.dragStart(desktopRow("Open folder Drafts"), { dataTransfer: dataTransfer() });
    fireEvent.drop(desktopRow("Open folder Specs"), { dataTransfer: dataTransfer() });
    await waitFor(() => expect(screen.getAllByTitle("4 docs, 1 file, 2 folders").length).toBe(2));
    expect(screen.getAllByText("7 items").length).toBe(2);
    expect(putCalls().map(([u]) => u)).toEqual(["/api/docs/d1", "/api/folders/f2"]);
  });

  // Deletes go to the recycle bin: the dialog says so (and what a folder takes
  // with it), and the toast's Undo restores the entry and refetches.
  it("bins a folder with an Undo that restores it", async () => {
    vi.mocked(apiFetchJson).mockImplementation(async (url: string, opts?: RequestInit) => {
      if (String(url).includes("/contents")) {
        return { ok: true, status: 200, data: { ...emptyContents, folders: [folder("f1", "Specs")], folderCounts: { f1: { docs: 2, files: 1, folders: 0 } } } };
      }
      if (url === "/api/folders/f1" && opts?.method === "DELETE") {
        return { ok: true, status: 200, data: { deleted: true, trashEntryId: "t1", homeDocMoved: false } };
      }
      return { ok: true, status: 200, data: {} };
    });
    renderManager(null);
    fireEvent.keyDown((await screen.findAllByLabelText("Actions for folder Specs"))[0], { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByText(/everything in it \(2 docs, 1 file\) will be moved to the recycle bin/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Moved "Specs" to the recycle bin.' })));
    const contentLoads = () => vi.mocked(apiFetchJson).mock.calls.filter(([u]) => String(u).includes("/contents")).length;
    const loadsBefore = contentLoads();
    const { action } = toastSpy.mock.calls.at(-1)![0] as { action: { label: string; onClick: () => void } };
    expect(action.label).toBe("Undo");
    action.onClick();

    await waitFor(() =>
      expect(vi.mocked(apiFetchJson).mock.calls.some(([u, o]) => u === "/api/projects/p1/trash/t1/restore" && (o as RequestInit)?.method === "POST")).toBe(true),
    );
    await waitFor(() => expect(contentLoads()).toBeGreaterThan(loadsBefore));
  });

  // Touch widths: the card list hides row checkboxes until a selection starts
  // (from a row's "Select" menu item), and choosing a menu item must not also
  // trigger the row's own open action.
  it("shows mobile row checkboxes only once a selection starts", async () => {
    vi.mocked(apiFetchJson).mockImplementation(async (url: string) => {
      if (String(url).includes("/contents")) {
        return { ok: true, status: 200, data: { ...emptyContents, docs: [doc("d1", "Doc A"), doc("d2", "Doc B")] } };
      }
      return { ok: true, status: 200, data: emptyContents };
    });
    renderManager(null);
    // Desktop table only - the mobile card list renders no checkboxes yet.
    expect(await screen.findAllByLabelText("Select Doc A")).toHaveLength(1);

    fireEvent.keyDown(screen.getAllByLabelText("Document actions")[0], { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Select" }));

    await waitFor(() => expect(screen.getAllByLabelText("Select Doc A")).toHaveLength(2));
    expect(screen.getAllByLabelText("Select Doc B")).toHaveLength(2);
    expect(screen.getByLabelText("Delete 1 selected")).toBeTruthy();
  });

  it("cancels the new-folder dialog without creating anything", async () => {
    vi.mocked(apiFetchJson).mockResolvedValue({ ok: true, status: 200, data: emptyContents });
    renderManager(null);
    // Secondary create actions sit behind the split button's chevron.
    fireEvent.keyDown(await screen.findByRole("button", { name: "More create options" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "New folder" }));
    expect(await screen.findByText("Folders group docs, files and drawings.")).toBeTruthy();
    fireEvent.change(await screen.findByLabelText("Folder name"), { target: { value: "Specs" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByLabelText("Folder name")).toBeNull());
    expect(vi.mocked(apiFetchJson).mock.calls.some(([u]) => u === "/api/folders")).toBe(false);
  });

  // Folder rows take part in bulk selection like docs/files: checking one
  // counts toward "Delete (N)" and the bulk delete bins it via the folder route.
  it("bulk-deletes a checked folder alongside docs", async () => {
    vi.mocked(apiFetchJson).mockImplementation(async (url: string, opts?: RequestInit) => {
      if (String(url).includes("/contents")) {
        return { ok: true, status: 200, data: { ...emptyContents, folders: [folder("f1", "Specs")], docs: [doc("d1", "Doc A")] } };
      }
      if (url === "/api/folders/f1" && opts?.method === "DELETE") {
        return { ok: true, status: 200, data: { deleted: true, trashEntryId: "t1", homeDocMoved: false } };
      }
      return { ok: true, status: 200, data: {} };
    });
    const { apiFetch } = await import("@/lib/apiFetch");
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 200 }));
    renderManager(null);
    fireEvent.click((await screen.findAllByLabelText("Select folder Specs"))[0]);
    fireEvent.click(screen.getAllByLabelText("Select Doc A")[0]);
    fireEvent.click(screen.getByLabelText("Delete 2 selected"));
    expect(await screen.findByText(/Folders go with everything in them/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(vi.mocked(apiFetchJson).mock.calls.some(([u, o]) => u === "/api/folders/f1" && (o as RequestInit)?.method === "DELETE")).toBe(true),
    );
    expect(vi.mocked(apiFetch).mock.calls.some(([u, o]) => u === "/api/docs/d1" && (o as RequestInit)?.method === "DELETE")).toBe(true);
    await waitFor(() => expect(screen.queryAllByLabelText("Open folder Specs")).toHaveLength(0));
    expect(screen.queryByLabelText(/Delete \d+ selected/)).toBeNull();
  });

  // Folder rows: the item count sits in the Size column (breakdown in the
  // tooltip), and cells that don't apply or aren't known show a muted dash.
  // Doc rows dash their Size too.
  it("puts the folder count in Size and dashes inapplicable cells", async () => {
    vi.mocked(apiFetchJson).mockResolvedValue({
      ok: true, status: 200,
      data: {
        ...emptyContents,
        folders: [folder("fc1", "Specs"), folder("fc2", "Blank")],
        docs: [doc("d1", "Doc A")],
        folderCounts: { fc1: { docs: 1, files: 0, folders: 0 } },
      },
    });
    renderManager(null);
    await screen.findAllByLabelText("Open folder Specs");
    const cell = (label: string, col: number) => desktopRow(label).querySelector(`[data-col="${col}"]`)!;
    // Name is just the name - no inline count.
    expect(cell("Open folder Specs", 0).textContent).toBe("Specs");
    expect(cell("Open folder Specs", 2).textContent).toBe("1 item");
    expect(cell("Open folder Specs", 2).querySelector('[title="1 doc"]')).toBeTruthy();
    expect(cell("Open folder Blank", 2).textContent).toBe("Empty");
    // Author / last updated (folder never opened) / doc size: a muted dash
    // with a screen-reader label.
    for (const [label, col] of [["Open folder Specs", 1], ["Open folder Specs", 3], ["Open Doc A", 2]] as const) {
      expect(cell(label, col).querySelector('[aria-hidden="true"]')?.textContent).toBe("—");
      expect(cell(label, col).querySelector(".sr-only")).toBeTruthy();
    }
    // Size is right-aligned with tabular figures so sizes line up.
    expect(cell("Open Doc A", 2).className).toContain("justify-end");
    expect(cell("Open Doc A", 2).className).toContain("tabular-nums");
  });

  // A folder row shows its newest child's edit time once that folder's
  // contents have been loaded (e.g. the user opened it and came back up).
  it("shows a visited folder's newest child date in Last updated", async () => {
    const recent = new Date(Date.now() - 2 * 3_600_000).toISOString();
    vi.mocked(apiFetchJson).mockImplementation(async (url: string) => {
      if (String(url).includes("/contents?folderId=fv1")) {
        return {
          ok: true, status: 200,
          data: { ...emptyContents, docs: [{ ...doc("d1", "Old"), folder_id: "fv1" }, { ...doc("d2", "New"), folder_id: "fv1", updated_at: recent }] },
        };
      }
      return { ok: true, status: 200, data: { ...emptyContents, folders: [folder("fv1", "Guides")], folderCounts: { fv1: { docs: 2, files: 0, folders: 0 } } } };
    });
    const { rerenderWith } = renderManager("fv1");
    await screen.findAllByLabelText("Open New");
    rerenderWith(null);
    await screen.findAllByLabelText("Open folder Guides");
    expect(desktopRow("Open folder Guides").querySelector('[data-col="3"]')!.textContent).toBe("2h ago");
  });

  // Creation is one split button: "New document" plus a chevron menu holding
  // the secondary creates and Upload.
  it("offers folder, drawing and upload from the create menu", async () => {
    vi.mocked(apiFetchJson).mockResolvedValue({ ok: true, status: 200, data: emptyContents });
    renderManager(null);
    expect(await screen.findByRole("button", { name: "New document" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload files" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "More create options" }), { key: "Enter" });
    for (const name of ["New folder", "New drawing", "Upload files"]) {
      expect(await screen.findByRole("menuitem", { name })).toBeTruthy();
    }
  });

  // md+: the split button moves into the app top bar's action slot and is
  // rendered only there, so its accessible names stay unique.
  it("renders the create split button once, in the top bar on desktop", async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
    try {
      vi.mocked(apiFetchJson).mockResolvedValue({ ok: true, status: 200, data: emptyContents });
      const slot = document.createElement("div");
      document.body.appendChild(slot);
      renderManager(null, "owner", slot);
      const newDoc = await screen.findByRole("button", { name: "New document" });
      expect(slot.contains(newDoc)).toBe(true);
      expect(screen.getAllByRole("button", { name: "New document" })).toHaveLength(1);
      expect(slot.contains(screen.getByRole("button", { name: "More create options" }))).toBe(true);
      slot.remove();
    } finally {
      window.matchMedia = original;
    }
  });

  // Row download buttons fade in on hover/focus but stay in the DOM (and tab
  // order); the kebab is always visible.
  it("keeps row download buttons reachable while visually hover-only", async () => {
    vi.mocked(apiFetchJson).mockResolvedValue({ ok: true, status: 200, data: { ...emptyContents, docs: [doc("d1", "Doc A")] } });
    renderManager(null);
    const download = await screen.findByRole("button", { name: "Download Doc A as markdown" });
    expect(download.className).toContain("opacity-0");
    expect(download.className).toContain("group-focus-within/row:opacity-100");
    expect(download.getAttribute("tabindex")).not.toBe("-1");
    expect(screen.getAllByLabelText("Actions for Doc A")[0].className).not.toContain("opacity-0");
  });

  // Header select-all is tri-state and covers every visible row except the
  // (unselectable) home doc.
  it("selects all visible rows from the header checkbox", async () => {
    vi.mocked(apiFetchJson).mockResolvedValue({
      ok: true, status: 200,
      data: {
        ...emptyContents,
        folders: [folder("f1", "Specs")],
        docs: [{ ...doc("h1", "Home"), is_home: 1 }, doc("d1", "Doc A"), doc("d2", "Doc B")],
      },
    });
    renderManager(null);
    const header = await screen.findByRole("checkbox", { name: "Select all" });
    expect(header.getAttribute("data-state")).toBe("unchecked");

    fireEvent.click(screen.getAllByLabelText("Select Doc A")[0]);
    expect(header.getAttribute("data-state")).toBe("indeterminate");

    fireEvent.click(header);
    expect(screen.getByLabelText("Delete 3 selected")).toBeTruthy();
    const deselect = screen.getByRole("checkbox", { name: "Deselect all" });
    expect(deselect.getAttribute("data-state")).toBe("checked");

    fireEvent.click(deselect);
    expect(screen.queryByLabelText(/Delete \d+ selected/)).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Select all" }).getAttribute("data-state")).toBe("unchecked");
  });

  // The search box also matches this folder's own folders and files by name
  // (the server search covers docs only).
  it("includes name-matching files in search results", async () => {
    vi.mocked(apiFetchJson).mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/contents")) {
        return {
          ok: true, status: 200,
          data: {
            ...emptyContents,
            files: [
              { id: "x1", name: "alpha-notes.txt", mime_type: "text/plain", size: 10, folder_id: null, uploaded_by: "u1", created_at: "2026-01-01T00:00:00Z" },
              { id: "x2", name: "beta.png", mime_type: "image/png", size: 10, folder_id: null, uploaded_by: "u1", created_at: "2026-01-01T00:00:00Z" },
            ],
          },
        };
      }
      if (u.startsWith("/api/docs?")) return { ok: true, status: 200, data: [] };
      return { ok: true, status: 200, data: emptyContents };
    });
    renderManager(null);
    await screen.findAllByText("beta.png");
    fireEvent.change(screen.getByLabelText("Search files and documents"), { target: { value: "ALPHA" } });
    await waitFor(() => expect(screen.queryByText("beta.png")).toBeNull());
    expect(screen.getAllByText("alpha-notes.txt").length).toBeGreaterThan(0);
    expect(screen.queryByText("No results")).toBeNull();
  });
});
