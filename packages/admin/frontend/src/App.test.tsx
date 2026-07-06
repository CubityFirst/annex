import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", () => {
  class TransientVerifyError extends Error {}
  class AdminHandoffError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  }
  return {
    TransientVerifyError,
    AdminHandoffError,
    LIST_PAGE_SIZE: 25,
    verifyAdminSession: vi.fn(),
    logoutAdminSession: vi.fn(async () => undefined),
    exchangeAdminHandoff: vi.fn(),
    searchUsers: vi.fn(async () => ({ users: [], nextCursor: null })),
    getUserDetails: vi.fn(),
    updateUserBadges: vi.fn(),
    updateUserModeration: vi.fn(),
    forceUserPasswordChange: vi.fn(),
    deleteUserAvatar: vi.fn(),
    exportUserData: vi.fn(),
    grantInk: vi.fn(),
    revokeGrantedInk: vi.fn(),
    giftFreeMonth: vi.fn(),
    cancelUserSubscription: vi.fn(),
    listProjects: vi.fn(async () => ({ projects: [], nextCursor: null })),
    getProjectDetails: vi.fn(),
    fetchProjectLogo: vi.fn(async () => null),
    updateProjectFeatures: vi.fn(),
    deleteProject: vi.fn(),
    reindexProjectFts: vi.fn(),
    removeProjectDomain: vi.fn(),
    listAuditLog: vi.fn(async () => ({ entries: [], nextCursor: null })),
    listAuditActions: vi.fn(async () => []),
    listOAuthClients: vi.fn(async () => []),
    createOAuthClient: vi.fn(),
    deleteOAuthClient: vi.fn(),
    rotateOAuthClientSecret: vi.fn(),
    setOAuthClientDisabled: vi.fn(),
  };
});

import { App } from "./App";
import { TransientVerifyError, verifyAdminSession } from "@/lib/api";
import { setToken } from "@/lib/auth";

const SESSION = {
  userId: "u-1",
  email: "admin@example.com",
  expiresAt: Date.now() + 3600_000,
  isAdmin: true as const,
};

function renderApp(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

describe("App session gating", () => {
  it("shows the login page with no token", async () => {
    renderApp();
    expect(await screen.findByText(/Continue to Annex sign-in/)).toBeInTheDocument();
    expect(verifyAdminSession).not.toHaveBeenCalled();
  });

  it("renders the admin shell for a verified admin session", async () => {
    setToken("tok");
    vi.mocked(verifyAdminSession).mockResolvedValue(SESSION);
    renderApp();
    expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
    expect(screen.getByText("Sign out")).toBeInTheDocument();
  });

  it("bounces to login (token cleared) when verification says the session is invalid", async () => {
    setToken("tok");
    vi.mocked(verifyAdminSession).mockRejectedValue(new Error("Unauthorized"));
    renderApp();
    expect(await screen.findByText(/Continue to Annex sign-in/)).toBeInTheDocument();
  });

  it("shows a RETRY screen (keeps the token) on a transient verify failure (AF-C6)", async () => {
    setToken("tok");
    vi.mocked(verifyAdminSession).mockRejectedValue(new TransientVerifyError("offline"));
    renderApp();
    expect(await screen.findByText(/Couldn't reach the admin API/)).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
    expect(screen.queryByText(/Continue to Annex sign-in/)).not.toBeInTheDocument();
  });

  it("rejects a token whose own expiry has passed even if the server said ok", async () => {
    setToken("tok");
    vi.mocked(verifyAdminSession).mockResolvedValue({ ...SESSION, expiresAt: Date.now() - 1000 });
    renderApp();
    expect(await screen.findByText(/Continue to Annex sign-in/)).toBeInTheDocument();
  });
});
