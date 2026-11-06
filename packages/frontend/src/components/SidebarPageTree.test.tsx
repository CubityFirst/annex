import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SidebarPageTree, type TreeDoc, type TreeFile, type TreeFolder } from "./SidebarPageTree";

const FOLDERS: TreeFolder[] = [
  { id: "f-guides", name: "Guides", parent_id: null },
  { id: "f-deep", name: "Deep", parent_id: "f-guides" },
];
const DOCS: TreeDoc[] = [
  { id: "d-b", title: "Beta", folder_id: null },
  { id: "d-home", title: "Home", folder_id: null, is_home: 1 },
  { id: "d-inner", title: "Inner doc", folder_id: "f-deep" },
];
const FILES: TreeFile[] = [{ id: "a-1", name: "photo.png", mime_type: "image/png", folder_id: null }];

function renderAt(path: string, docs = DOCS) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<SidebarPageTree projectId="p1" docs={docs} folders={FOLDERS} files={FILES} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SidebarPageTree", () => {
  beforeEach(() => localStorage.clear());

  it("lists root folders, docs (home first) and files; folders start collapsed", () => {
    renderAt("/projects/p1");
    const nav = screen.getByRole("navigation", { name: "Pages" });
    const labels = within(nav).getAllByRole("link").map(a => a.textContent);
    expect(labels).toEqual(["Home", "Beta", "photo.png"]);
    expect(within(nav).getByRole("button", { name: "Guides" })).toHaveAttribute("aria-expanded", "false");
    expect(within(nav).queryByText("Inner doc")).toBeNull();
    expect(within(nav).getByRole("link", { name: "photo.png" })).toHaveAttribute("href", "/projects/p1/files/a-1");
  });

  it("auto-expands the ancestors of the open doc and highlights it", () => {
    renderAt("/projects/p1/docs/d-inner");
    const link = screen.getByRole("link", { name: "Inner doc" });
    expect(link).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Guides" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Deep" })).toHaveAttribute("aria-expanded", "true");
  });

  it("toggles folders and remembers expanded state per site", async () => {
    const { unmount } = renderAt("/projects/p1");
    await userEvent.click(screen.getByRole("button", { name: "Guides" }));
    expect(screen.getByRole("button", { name: "Deep" })).toBeInTheDocument();
    unmount();
    renderAt("/projects/p1");
    expect(screen.getByRole("button", { name: "Guides" })).toHaveAttribute("aria-expanded", "true");
  });

  it("caps long levels behind a Show more button", async () => {
    const many: TreeDoc[] = Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, title: `Doc ${String(i).padStart(2, "0")}`, folder_id: null }));
    renderAt("/projects/p1", many);
    const nav = screen.getByRole("navigation", { name: "Pages" });
    // 1 folder + 60 docs + 1 file at the root: the folder takes one of the 50 slots.
    expect(within(nav).getAllByRole("link").filter(a => a.textContent?.startsWith("Doc "))).toHaveLength(49);
    await userEvent.click(within(nav).getByRole("button", { name: "Show 12 more" }));
    expect(within(nav).getAllByRole("link").filter(a => a.textContent?.startsWith("Doc "))).toHaveLength(60);
  });

  it("renders nothing for an empty site", () => {
    render(
      <MemoryRouter>
        <SidebarPageTree projectId="p1" docs={[]} folders={[]} files={[]} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();
  });
});
