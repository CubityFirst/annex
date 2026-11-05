import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { TagPage } from "./TagPage";

type Doc = { id: string; title: string; display_title?: string | null; tags: string | null; folder_id: string | null; updated_at?: string };

function renderTagPage(docs: Doc[], folders: { id: string; name: string; parent_id: string | null }[] = [], path = "/projects/p1/tags/alpha") {
  const setBreadcrumbs = vi.fn();
  const ctx = { docs, folders, setBreadcrumbs, projectName: "Demo Site" };
  const { unmount } = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Outlet context={ctx} />}>
          <Route path="/projects/:projectId/tags/:tag" element={<TagPage />} />
          <Route path="/projects/:projectId/docs/:docId" element={<div>DOC PAGE</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return { setBreadcrumbs, unmount };
}

const taggedDoc: Doc = { id: "d1", title: "Alpha Doc", tags: JSON.stringify(["alpha", "beta"]), folder_id: null };
const otherDoc: Doc = { id: "d2", title: "Other Doc", tags: JSON.stringify(["gamma"]), folder_id: null };

describe("TagPage", () => {
  it("lists only docs carrying the active tag, with a count", () => {
    renderTagPage([taggedDoc, otherDoc]);
    expect(screen.getByRole("heading", { name: "alpha" })).toBeInTheDocument();
    expect(screen.getByText("Alpha Doc")).toBeInTheDocument();
    expect(screen.queryByText("Other Doc")).not.toBeInTheDocument();
    // Muted sub-line under the title carries the count.
    expect(screen.getByText(/1 document tagged/)).toHaveTextContent("1 document tagged alpha");
  });

  it("shows an empty state when no doc has the tag", () => {
    renderTagPage([otherDoc]);
    expect(screen.getByText(/no documents found with this tag/i)).toBeInTheDocument();
  });

  it("prefers display_title over title", () => {
    renderTagPage([{ ...taggedDoc, display_title: "Pretty Alpha" }]);
    expect(screen.getByText("Pretty Alpha")).toBeInTheDocument();
  });

  it("renders the folder path for a doc inside a folder", () => {
    const docInFolder: Doc = { ...taggedDoc, folder_id: "f2" };
    const folders = [
      { id: "f1", name: "Root", parent_id: null },
      { id: "f2", name: "Child", parent_id: "f1" },
    ];
    renderTagPage([docInFolder], folders);
    expect(screen.getByText("Root / Child")).toBeInTheDocument();
  });

  it("shows a relative updated date when the doc carries updated_at", () => {
    const updated_at = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    renderTagPage([{ ...taggedDoc, updated_at }]);
    expect(screen.getByText("3h ago")).toBeInTheDocument();
  });

  it("navigates to the doc when a result is clicked", async () => {
    renderTagPage([taggedDoc]);
    await userEvent.click(screen.getByText("Alpha Doc"));
    expect(screen.getByText("DOC PAGE")).toBeInTheDocument();
  });

  it("sets and clears breadcrumbs", () => {
    const { setBreadcrumbs, unmount } = renderTagPage([taggedDoc]);
    expect(setBreadcrumbs).toHaveBeenCalledWith([
      { id: null, name: "Demo Site", onClick: expect.any(Function) },
      { id: null, name: "Tags" },
      { id: null, name: "alpha" },
    ]);
    // Unmount must run the effect cleanup, which clears the breadcrumbs.
    unmount();
    expect(setBreadcrumbs).toHaveBeenLastCalledWith([]);
  });
});
