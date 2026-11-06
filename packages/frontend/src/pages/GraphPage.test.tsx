import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";

// The real GraphView pulls in react-force-graph-2d / canvas-heavy rendering that
// jsdom can't drive. Mock it to a marker and a node-click trigger so we can
// assert the page fetches, passes data through, and wires navigation.
vi.mock("@/components/GraphView", () => ({
  GraphView: ({ data, onNodeClick }: { data: { nodes: { id: string }[] }; onNodeClick: (id: string) => void }) => (
    <div data-testid="graph" data-node-count={data.nodes.length}>
      <button onClick={() => onNodeClick("d1")}>node</button>
    </div>
  ),
}));

import { GraphPage } from "./GraphPage";

function renderAt(path = "/projects/p1/graph") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Outlet context={{ projectName: "Proj", setBreadcrumbs: vi.fn() }} />}>
          <Route path="/projects/:projectId/graph" element={<GraphPage />} />
        </Route>
        <Route path="/projects/:projectId/docs/:docId" element={<div>DOC PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockFetch(json: unknown) {
  return vi.fn().mockResolvedValue({ json: () => Promise.resolve(json) });
}

const sampleData = {
  nodes: [
    { id: "d1", title: "Alpha", links: 1 },
    { id: "d2", title: "Beta", links: 1 },
  ],
  edges: [{ source: "d1", target: "d2" }],
};

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("token", "jwt-123");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("GraphPage", () => {
  it("shows the loading state initially", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderAt();
    expect(screen.getByText(/loading graph/i)).toBeInTheDocument();
  });

  it("fetches the project graph and renders the GraphView with the data", async () => {
    const fetchMock = mockFetch({ ok: true, data: sampleData });
    vi.stubGlobal("fetch", fetchMock);
    renderAt();

    const graph = await screen.findByTestId("graph");
    expect(graph).toHaveAttribute("data-node-count", "2");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p1/graph",
      expect.objectContaining({ headers: { Authorization: "Bearer jwt-123" } }),
    );
  });

  it("shows a summary card with doc and link counts", async () => {
    vi.stubGlobal("fetch", mockFetch({ ok: true, data: sampleData }));
    renderAt();
    const summary = await screen.findByTestId("graph-summary");
    expect(summary).toHaveTextContent("2 docs · 1 link");
    // No tag colours configured: no legend.
    expect(screen.queryByRole("list", { name: "Tag color legend" })).not.toBeInTheDocument();
  });

  it("lists only the tag colours that colour a node in the legend", async () => {
    const data = {
      nodes: [
        { id: "d1", title: "Alpha", links: 1, tags: ["lore"] },
        { id: "d2", title: "Beta", links: 1, tags: [] },
      ],
      edges: [{ source: "d1", target: "d2" }],
      tagColors: [
        { tag: "lore", color: "#ff0000" },
        { tag: "unused", color: "#00ff00" },
      ],
    };
    vi.stubGlobal("fetch", mockFetch({ ok: true, data }));
    renderAt();
    const legend = await screen.findByRole("list", { name: "Tag color legend" });
    expect(legend).toHaveTextContent("lore");
    expect(legend).not.toHaveTextContent("unused");
  });

  it("navigates to the doc when a node is clicked", async () => {
    vi.stubGlobal("fetch", mockFetch({ ok: true, data: sampleData }));
    renderAt();

    await userEvent.click(await screen.findByRole("button", { name: "node" }));
    expect(screen.getByText("DOC PAGE")).toBeInTheDocument();
  });

  it("shows the empty state when there are no nodes", async () => {
    vi.stubGlobal("fetch", mockFetch({ ok: true, data: { nodes: [], edges: [] } }));
    renderAt();
    expect(await screen.findByText(/no documents to graph yet/i)).toBeInTheDocument();
  });

  it("shows the server error message when the request fails", async () => {
    vi.stubGlobal("fetch", mockFetch({ ok: false, error: "Boom" }));
    renderAt();
    expect(await screen.findByText("Boom")).toBeInTheDocument();
  });

  it("shows a connection error when the fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    renderAt();
    expect(await screen.findByText(/could not connect to the server/i)).toBeInTheDocument();
  });

  it("stays in the loading state without a token (never fetches)", () => {
    window.localStorage.clear();
    const fetchMock = mockFetch({ ok: true, data: sampleData });
    vi.stubGlobal("fetch", fetchMock);
    renderAt();
    expect(screen.getByText(/loading graph/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
