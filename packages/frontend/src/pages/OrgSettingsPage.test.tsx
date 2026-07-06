import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { apiFetchJson } from "@/lib/apiFetch";
import { OrgSettingsPage } from "./OrgSettingsPage";

vi.mock("@/lib/apiFetch", () => ({ apiFetchJson: vi.fn() }));
const mockApi = vi.mocked(apiFetchJson);

// Quiet the toast hook (renders into a portal store; not needed for assertions).
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

type Role = "viewer" | "editor" | "admin" | "owner";

const owner = { id: "o1", name: "Acme Inc", role: "owner" as Role };
const viewerOrg = { id: "o1", name: "Acme Inc", role: "viewer" as Role };

const aliceMember = { id: "m2", userId: "u2", email: "alice@x.com", name: "Alice", role: "editor" as Role, accepted: true };
const pendingMember = { id: "m3", userId: "u3", email: "pending@x.com", name: "pending@x.com", role: "viewer" as Role, accepted: false };

const attachedSite = { id: "s1", name: "Handbook" };
const ownedAttachable = [
  { id: "s9", name: "Spare Site", role: "owner", organization_id: null },
  { id: "s8", name: "In Org Already", role: "owner", organization_id: "other" },
];

interface Config {
  org?: { id: string; name: string; role: Role } | { status: number };
  members?: unknown[];
  sites?: unknown[];
  owned?: unknown[];
}

function installApi(cfg: Config) {
  mockApi.mockImplementation(async (url: string, opts?: { method?: string }) => {
    const method = opts?.method ?? "GET";

    if (url === "/api/projects") {
      return { ok: true, status: 200, data: cfg.owned ?? ownedAttachable } as never;
    }

    // .../members/:userId  (PATCH role, DELETE remove/leave)
    if (/\/members\/[^/]+$/.test(url)) {
      return { ok: true, status: 200, data: { role: "viewer" } } as never;
    }
    // .../members  (GET list, POST invite)
    if (url.endsWith("/members")) {
      if (method === "POST") {
        return { ok: true, status: 200, data: { id: "m9", userId: "u9", email: "bob@x.com", name: "Bob", role: "viewer", accepted: false } } as never;
      }
      return { ok: true, status: 200, data: cfg.members ?? [] } as never;
    }
    // .../projects/:id/attach  (POST attach, DELETE detach)
    if (url.endsWith("/attach")) {
      return { ok: true, status: 200 } as never;
    }
    // .../projects  (org's sites)
    if (url.endsWith("/projects")) {
      return { ok: true, status: 200, data: cfg.sites ?? [] } as never;
    }
    // org detail  /api/organizations/o1  (GET, PATCH rename, DELETE)
    const org = cfg.org ?? owner;
    if ("status" in org) return { ok: false, status: org.status } as never;
    if (method === "PATCH") return { ok: true, status: 200, data: { ...org, name: "Renamed" } } as never;
    return { ok: true, status: 200, data: org } as never;
  });
}

function renderSettings(currentUser: { id: string; name: string } | null = { id: "me", name: "Me" }) {
  const ctx = { currentUser };
  return render(
    <MemoryRouter initialEntries={["/orgs/o1/settings"]}>
      <Routes>
        <Route element={<Outlet context={ctx} />}>
          <Route path="/orgs/:orgId/settings" element={<OrgSettingsPage />} />
        </Route>
        <Route path="/dashboard" element={<div>DASHBOARD</div>} />
        <Route path="/projects/:projectId" element={<div>PROJECT PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  mockApi.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("OrgSettingsPage", () => {
  it("renders the org name and admin sections for an owner", async () => {
    installApi({ org: owner, members: [aliceMember], sites: [attachedSite] });
    renderSettings();

    expect(await screen.findByText("Acme Inc")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Members" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sites" })).toBeInTheDocument();
    // member + attached site render
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Handbook")).toBeInTheDocument();
  });

  it("renders the not-found state when the org is inaccessible", async () => {
    installApi({ org: { status: 403 } });
    renderSettings();
    expect(await screen.findByText(/organization not found/i)).toBeInTheDocument();
  });

  it("shows a load-error state when the org fetch rejects", async () => {
    mockApi.mockImplementation(async (url: string) => {
      if (url === "/api/organizations/o1") throw new Error("network");
      return { ok: true, status: 200, data: [] } as never;
    });
    renderSettings();
    expect(await screen.findByText(/could not load this organization/i)).toBeInTheDocument();
  });

  it("hides admin-only sections and shows Leave for a non-admin member", async () => {
    installApi({ org: viewerOrg, members: [], sites: [] });
    renderSettings();

    expect(await screen.findByText("Acme Inc")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Members" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sites" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /leave organization/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete organization/i })).not.toBeInTheDocument();
  });

  it("renames the organization via PATCH", async () => {
    installApi({ org: owner, members: [], sites: [] });
    renderSettings();

    const input = await screen.findByLabelText("Name");
    await userEvent.clear(input);
    await userEvent.type(input, "New Name");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        "/api/organizations/o1",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "New Name" }) }),
      ),
    );
  });

  it("invites a member by email and appends them to the list", async () => {
    installApi({ org: owner, members: [], sites: [] });
    renderSettings();

    await screen.findByRole("heading", { name: "Members" });
    await userEvent.type(screen.getByLabelText(/invite by email/i), "bob@x.com");
    await userEvent.click(screen.getByRole("button", { name: /^invite$/i }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        "/api/organizations/o1/members",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ email: "bob@x.com", role: "viewer" }) }),
      ),
    );
    expect(await screen.findByText("bob@x.com")).toBeInTheDocument();
  });

  it("removes a member via DELETE", async () => {
    installApi({ org: owner, members: [aliceMember], sites: [] });
    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: /^remove$/i }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        "/api/organizations/o1/members/u2",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("Alice")).not.toBeInTheDocument());
  });

  it("detaches a site via DELETE attach after confirming the dialog", async () => {
    installApi({ org: owner, members: [], sites: [attachedSite] });
    renderSettings();

    // Open the per-row confirmation dialog…
    await userEvent.click(await screen.findByRole("button", { name: /detach/i }));
    // …then confirm via the dialog's Detach action.
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^detach$/i }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        "/api/organizations/o1/projects/s1/attach",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("Handbook")).not.toBeInTheDocument());
  });

  it("deletes the org from the danger zone and returns to the dashboard", async () => {
    installApi({ org: owner, members: [], sites: [] });
    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: /delete organization/i }));
    await userEvent.click(await screen.findByRole("button", { name: /yes, delete/i }));

    await waitFor(() => expect(screen.getByText("DASHBOARD")).toBeInTheDocument());
    expect(mockApi).toHaveBeenCalledWith("/api/organizations/o1", expect.objectContaining({ method: "DELETE" }));
  });

  it("lets a non-admin leave the org from the danger zone", async () => {
    installApi({ org: viewerOrg, members: [], sites: [] });
    renderSettings({ id: "me", name: "Me" });

    await userEvent.click(await screen.findByRole("button", { name: /leave organization/i }));
    await userEvent.click(await screen.findByRole("button", { name: /yes, leave/i }));

    await waitFor(() => expect(screen.getByText("DASHBOARD")).toBeInTheDocument());
    expect(mockApi).toHaveBeenCalledWith("/api/organizations/o1/members/me", expect.objectContaining({ method: "DELETE" }));
  });
});
