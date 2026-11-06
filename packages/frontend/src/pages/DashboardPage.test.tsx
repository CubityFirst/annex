import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ProjectListItem } from "@/layouts/DocsLayout";
import { DashboardPage } from "./DashboardPage";

vi.mock("@/lib/auth", () => ({ getToken: () => "tok" }));

function site(overrides: Partial<ProjectListItem>): ProjectListItem {
  return {
    id: "s1",
    name: "Handbook",
    description: null,
    role: "owner",
    published_at: null,
    changelog_mode: "off",
    ai_enabled: 0,
    ai_summarization_type: "manual",
    graph_enabled: 0,
    is_favourite: 0,
    is_hidden: 0,
    features: 0,
    logo_square_updated_at: null,
    organization_id: null,
    organization_name: null,
    ...overrides,
  };
}

// Stands in for DocsLayout: owns the site list and hands it to the page via
// the outlet context, exactly as the real layout does.
function Layout({ initial }: { initial: ProjectListItem[] }) {
  const [projects, setProjects] = useState(initial);
  return <Outlet context={{ openCreateSite: () => {}, openCreateOrg: () => {}, projects, setProjects }} />;
}

function renderDashboard(projects: ProjectListItem[]) {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route element={<Layout initial={projects} />}>
            <Route path="/dashboard" element={<DashboardPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </TooltipProvider>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => Response.json({ ok: true, data: [] }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("DashboardPage", () => {
  it("renders the layout's site list without fetching /api/projects itself", async () => {
    renderDashboard([site({ id: "s1", name: "Handbook", doc_count: 3, member_count: 2 })]);
    expect(await screen.findByText("Handbook")).toBeInTheDocument();
    expect(screen.getByText("3 docs")).toBeInTheDocument();
    expect(screen.getByLabelText("2 members")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls.some(u => u.startsWith("/api/projects"))).toBe(false);
  });

  it("omits the count badges until the counted list has loaded", async () => {
    renderDashboard([site({ id: "s1", name: "Handbook" })]);
    expect(await screen.findByText("Handbook")).toBeInTheDocument();
    expect(screen.queryByText(/\bdocs?\b/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/members?$/)).not.toBeInTheDocument();
  });

  it("favouriting updates the shared list (and so the sidebar)", async () => {
    renderDashboard([
      site({ id: "s1", name: "Alpha", doc_count: 1, member_count: 1 }),
      site({ id: "s2", name: "Beta", doc_count: 1, member_count: 1 }),
    ]);
    await screen.findByText("Beta");
    await userEvent.click(screen.getAllByRole("button", { name: "Pin to top" })[1]);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/s2/favourite", expect.objectContaining({ method: "PATCH" }));
    // Pinned sites sort first.
    const titles = screen.getAllByRole("heading", { level: 3 }).map(h => h.textContent);
    expect(titles).toEqual(["Beta", "Alpha"]);
  });
});
