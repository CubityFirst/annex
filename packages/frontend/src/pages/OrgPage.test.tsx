import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { apiFetchJson } from "@/lib/apiFetch";
import { OrgPage } from "./OrgPage";

vi.mock("@/lib/apiFetch", () => ({ apiFetchJson: vi.fn() }));
const mockApi = vi.mocked(apiFetchJson);

type Role = "viewer" | "editor" | "admin" | "owner";

interface RouteResponses {
  org?: { id: string; name: string; role: Role } | { status: number };
  sites?: unknown[];
}

function installApi(res: RouteResponses) {
  mockApi.mockImplementation(async (url: string, opts?: { method?: string }) => {
    // create-site POST
    if (url === "/api/projects" && opts?.method === "POST") {
      return { ok: true, status: 200, data: { id: "new-site" } } as never;
    }
    if (url.endsWith("/projects")) {
      return { ok: true, status: 200, data: res.sites ?? [] } as never;
    }
    // org detail
    const org = res.org;
    if (org && "status" in org) {
      return { ok: false, status: org.status } as never;
    }
    return { ok: true, status: 200, data: org } as never;
  });
}

function renderOrgPage(path = "/orgs/o1") {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/orgs/:orgId" element={<OrgPage />} />
          <Route path="/orgs/:orgId/settings" element={<div>ORG SETTINGS</div>} />
          <Route path="/dashboard" element={<div>DASHBOARD</div>} />
          <Route path="/projects/:projectId" element={<div>PROJECT PAGE</div>} />
          <Route path="/s/:projectId" element={<div>PUBLIC SITE</div>} />
        </Routes>
      </MemoryRouter>
    </TooltipProvider>,
  );
}

const owner = { id: "o1", name: "Acme Inc", role: "owner" as Role };
const viewer = { id: "o1", name: "Acme Inc", role: "viewer" as Role };
const site = {
  id: "s1",
  name: "Handbook",
  description: "The team handbook",
  published_at: "2026-01-01",
  doc_count: 3,
  member_count: 5,
};

beforeEach(() => {
  window.localStorage.clear();
  mockApi.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("OrgPage", () => {
  it("renders the org name, role, and its site cards", async () => {
    installApi({ org: owner, sites: [site] });
    renderOrgPage();

    expect(await screen.findByRole("heading", { name: "Acme Inc" })).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("Handbook")).toBeInTheDocument();
    expect(screen.getByText("The team handbook")).toBeInTheDocument();
    expect(screen.getByText("3 docs")).toBeInTheDocument();
  });

  it("shows the empty state when the org has no sites", async () => {
    installApi({ org: owner, sites: [] });
    renderOrgPage();
    expect(await screen.findByText(/no sites in this organization yet/i)).toBeInTheDocument();
  });

  it("shows management controls for owners/admins", async () => {
    installApi({ org: owner, sites: [] });
    renderOrgPage();
    expect(await screen.findByRole("button", { name: /new site/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /settings/i })).toBeInTheDocument();
  });

  it("hides management controls for viewers", async () => {
    installApi({ org: viewer, sites: [site] });
    renderOrgPage();
    await screen.findByRole("heading", { name: "Acme Inc" });
    expect(screen.queryByRole("button", { name: /new site/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /settings/i })).not.toBeInTheDocument();
  });

  it("renders the not-found state when the org is inaccessible", async () => {
    installApi({ org: { status: 404 }, sites: [] });
    renderOrgPage();
    expect(await screen.findByText(/organization not found/i)).toBeInTheDocument();
  });

  it("navigates to a site when its card is clicked", async () => {
    installApi({ org: owner, sites: [site] });
    renderOrgPage();
    await userEvent.click(await screen.findByText("Handbook"));
    expect(screen.getByText("PROJECT PAGE")).toBeInTheDocument();
  });

  it("creates a site in the org and navigates to it", async () => {
    installApi({ org: owner, sites: [] });
    renderOrgPage();

    await userEvent.click(await screen.findByRole("button", { name: /new site/i }));
    await userEvent.type(await screen.findByLabelText("Name"), "Wiki");
    await userEvent.click(screen.getByRole("button", { name: /create site/i }));

    await waitFor(() => expect(screen.getByText("PROJECT PAGE")).toBeInTheDocument());
    expect(mockApi).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Wiki", organizationId: "o1" }),
      }),
    );
  });
});
