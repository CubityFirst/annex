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

function renderManager(folderId: string | null = null, myRole = "owner") {
  const ctx = { setBreadcrumbs: vi.fn() };
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
    const input = await screen.findByLabelText("New name");
    fireEvent.change(input, { target: { value: "Doc A renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() =>
      expect(vi.mocked(apiFetchJson).mock.calls.some(([u, o]) => u === "/api/docs/d1" && (o as RequestInit)?.method === "PUT")).toBe(true),
    );
    // Old title still listed, no optimistic apply...
    expect(screen.getAllByText("Doc A").length).toBeGreaterThan(0);
    expect(screen.queryByText("Doc A renamed")).toBeNull();
    // ...and the dialog stayed open for a retry.
    expect(screen.getByLabelText("New name")).toBeTruthy();
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
    fireEvent.change(screen.getByLabelText("Search documents"), { target: { value: "alp" } });
    // Debounced search (250ms) - wait for the search-mode list.
    await waitFor(() => expect(vi.mocked(apiFetchJson).mock.calls.some(([u]) => String(u).startsWith("/api/docs?"))).toBe(true));

    const pencil = (await screen.findAllByLabelText("Rename Alpha"))[0];
    fireEvent.click(pencil);
    const input = await screen.findByLabelText("New name");
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
    await screen.findAllByText("1 doc");

    // Doc into Specs.
    fireEvent.dragStart(desktopRow("Open Doc A"), { dataTransfer: dataTransfer() });
    fireEvent.dragOver(desktopRow("Open folder Specs"), { dataTransfer: dataTransfer() });
    fireEvent.drop(desktopRow("Open folder Specs"), { dataTransfer: dataTransfer() });
    await waitFor(() => expect(screen.getAllByText("2 docs").length).toBe(2)); // Specs badge, desktop + mobile
    fireEvent.dragEnd(desktopRow("Open folder Specs"));

    // Drafts (with its whole subtree) into Specs.
    fireEvent.dragStart(desktopRow("Open folder Drafts"), { dataTransfer: dataTransfer() });
    fireEvent.drop(desktopRow("Open folder Specs"), { dataTransfer: dataTransfer() });
    await waitFor(() => expect(screen.getAllByText("4 docs, 1 file, 2 folders").length).toBeGreaterThan(0));
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
});
