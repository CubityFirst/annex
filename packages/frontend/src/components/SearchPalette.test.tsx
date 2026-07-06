import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { SearchPalette } from "./SearchPalette";
import { pushRecentItem } from "@/lib/recentDocs";

vi.mock("@/lib/auth", () => ({ getToken: () => "test-token", clearToken: vi.fn() }));

const navigate = vi.fn();
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}));

Element.prototype.scrollIntoView = vi.fn();

// cmdk constructs a ResizeObserver; the arrow-function mock in test/setup.ts
// isn't constructible under vitest 4, so use a real class here.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

const DOC_HIT = {
  doc_id: "d1",
  title: "Coffee brewing guide",
  excerpt: "the best <mark>coffee</mark> is fresh",
  folder: "Guides",
  updated_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
};

const FILE_HIT = {
  file_id: "f1",
  name: "coffee-chart.png",
  mime_type: "image/png",
  folder: null,
  updated_at: new Date(Date.now() - 3600 * 1000).toISOString(),
};

function mockFetch(data: unknown) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPalette(props: Partial<Parameters<typeof SearchPalette>[0]> = {}) {
  return render(
    <MemoryRouter>
      <SearchPalette open onOpenChange={() => {}} projectId="p1" {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("SearchPalette", () => {
  it("shows recently viewed items before any query is typed", () => {
    pushRecentItem("p1", { id: "d9", title: "Session notes", kind: "doc" });
    mockFetch({ docs: [], files: [] });
    renderPalette();
    expect(screen.getByText("Recently viewed")).toBeInTheDocument();
    expect(screen.getByText("Session notes")).toBeInTheDocument();
  });

  it("hides recents in public mode and shows the hint instead", () => {
    pushRecentItem("p1", { id: "d9", title: "Session notes", kind: "doc" });
    mockFetch({ docs: [], files: [] });
    renderPalette({ isPublic: true });
    expect(screen.queryByText("Session notes")).not.toBeInTheDocument();
    expect(screen.getByText(/filter by tag/)).toBeInTheDocument();
  });

  it("renders grouped doc and file hits with folder context and highlighting", async () => {
    const fetchMock = mockFetch({ docs: [DOC_HIT], files: [FILE_HIT] });
    renderPalette();
    await userEvent.type(screen.getByPlaceholderText(/Search docs and files/), "coffee");

    expect(await screen.findByText("Documents")).toBeInTheDocument();
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(screen.getByText("Guides")).toBeInTheDocument();
    // Both the title/filename words and the excerpt term are <mark>-highlighted.
    const marks = document.querySelectorAll("mark");
    expect(marks.length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("2 results")).toBeInTheDocument();

    const url = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(url).toBe("/api/search?projectId=p1&q=coffee");
  });

  it("navigates to the file page when a file hit is selected", async () => {
    mockFetch({ docs: [], files: [FILE_HIT] });
    renderPalette();
    await userEvent.type(screen.getByPlaceholderText(/Search docs and files/), "coffee");
    // The name is split across <mark> spans - find the unhighlighted fragment
    // and click its enclosing cmdk item.
    const fragment = await screen.findByText("-chart.png");
    await userEvent.click(fragment.closest("[cmdk-item]") as HTMLElement);
    expect(navigate).toHaveBeenCalledWith("/projects/p1/files/f1");
  });

  it("hits the tag endpoint when the query starts with #", async () => {
    const fetchMock = mockFetch({ docs: [{ doc_id: "d1", title: "Coffee brewing guide", tags: ["coffee"], folder: null, updated_at: DOC_HIT.updated_at }], files: [] });
    renderPalette();
    await userEvent.type(screen.getByPlaceholderText(/Search docs and files/), "#coff");
    expect(await screen.findByText("Tagged documents")).toBeInTheDocument();
    const url = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(url).toBe("/api/search?projectId=p1&tag=coff");
  });

  it("shows no-results only after the response comes back empty", async () => {
    mockFetch({ docs: [], files: [] });
    renderPalette();
    await userEvent.type(screen.getByPlaceholderText(/Search docs and files/), "zzz");
    // Appears in both the visible list and the sr-only live region.
    expect((await screen.findAllByText("No results found.")).length).toBeGreaterThan(0);
  });

  it("role-gates the quick actions shown on the empty state", () => {
    mockFetch({ docs: [], files: [] });
    const { unmount } = renderPalette({ role: "owner" });
    expect(screen.getByText("New document")).toBeInTheDocument();
    expect(screen.getByText("Members")).toBeInTheDocument();
    expect(screen.getByText("Site settings")).toBeInTheDocument();
    unmount();
    renderPalette({ role: "viewer" });
    expect(screen.queryByText("New document")).not.toBeInTheDocument();
    expect(screen.queryByText("Members")).not.toBeInTheDocument();
    expect(screen.getByText("Site settings")).toBeInTheDocument();
  });

  it("filters actions by query and opens the new-document editor via New document", async () => {
    const fetchMock = mockFetch({ docs: [], files: [], folders: [] });
    renderPalette({ role: "editor" });
    await userEvent.type(screen.getByPlaceholderText(/Search docs and files/), "new");
    expect(screen.getByText("New document")).toBeInTheDocument();
    expect(screen.queryByText("Go to dashboard")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("New document"));
    // Nothing is created up front - the doc is only POSTed when the editor saves.
    expect(fetchMock.mock.calls.every(c => (c[1] as RequestInit | undefined)?.method !== "POST")).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/projects/p1/docs/new");
  });

  it("navigates to the folder page when a folder hit is selected", async () => {
    mockFetch({ docs: [], files: [], folders: [{ folder_id: "fo1", name: "Guides", parent: null }] });
    renderPalette();
    await userEvent.type(screen.getByPlaceholderText(/Search docs and files/), "guides");
    await userEvent.click(await screen.findByText("Guides"));
    expect(navigate).toHaveBeenCalledWith("/projects/p1/folders/fo1");
  });
});

describe("SearchPalette (dashboard mode)", () => {
  const SITES = [
    { id: "p1", name: "Campaign Notes", logo_square_updated_at: null },
    { id: "p2", name: "Recipe Book", logo_square_updated_at: null },
  ];

  it("lists all sites and dashboard actions with no query, without fetching", () => {
    const fetchMock = mockFetch({});
    renderPalette({ projectId: null, sites: SITES, onCreateSite: () => {}, onCreateOrg: () => {} });
    expect(screen.getByPlaceholderText("Search sites…")).toBeInTheDocument();
    expect(screen.getByText("Sites")).toBeInTheDocument();
    expect(screen.getByText("Campaign Notes")).toBeInTheDocument();
    expect(screen.getByText("Recipe Book")).toBeInTheDocument();
    expect(screen.getByText("New site")).toBeInTheDocument();
    expect(screen.getByText("New organization")).toBeInTheDocument();
    expect(screen.getByText("User settings")).toBeInTheDocument();
    // Site-only chrome stays hidden: no tag toggle, no server search.
    expect(screen.queryByText("Tags")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("filters sites client-side and navigates on select", async () => {
    const fetchMock = mockFetch({});
    renderPalette({ projectId: null, sites: SITES });
    await userEvent.type(screen.getByPlaceholderText("Search sites…"), "recipe");
    expect(screen.queryByText("Campaign Notes")).not.toBeInTheDocument();
    const fragment = screen.getByText("Recipe");
    await userEvent.click(fragment.closest("[cmdk-item]") as HTMLElement);
    expect(navigate).toHaveBeenCalledWith("/projects/p2");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits create actions when their callbacks are unset", () => {
    mockFetch({});
    renderPalette({ projectId: null, sites: SITES });
    expect(screen.queryByText("New site")).not.toBeInTheDocument();
    expect(screen.queryByText("New organization")).not.toBeInTheDocument();
    expect(screen.getByText("User settings")).toBeInTheDocument();
  });

  it("runs the New site action and navigates to user settings", async () => {
    mockFetch({});
    const onCreateSite = vi.fn();
    const { unmount } = renderPalette({ projectId: null, sites: SITES, onCreateSite });
    await userEvent.click(screen.getByText("New site"));
    expect(onCreateSite).toHaveBeenCalled();
    unmount();
    renderPalette({ projectId: null, sites: SITES });
    await userEvent.click(screen.getByText("User settings"));
    expect(navigate).toHaveBeenCalledWith("/settings");
  });

  it("shows no-results when the query matches nothing", async () => {
    mockFetch({});
    renderPalette({ projectId: null, sites: SITES });
    await userEvent.type(screen.getByPlaceholderText("Search sites…"), "zzz");
    expect((await screen.findAllByText("No results found.")).length).toBeGreaterThan(0);
  });
});
