import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { FileManager } from "./FileManager";
import { apiFetchJson } from "@/lib/apiFetch";

vi.mock("@/lib/apiFetch", () => ({
  apiFetchJson: vi.fn(),
  apiFetch: vi.fn(),
}));

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

function renderManager(folderId: string | null = null) {
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
                myRole="owner"
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
                  myRole="owner"
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
});
