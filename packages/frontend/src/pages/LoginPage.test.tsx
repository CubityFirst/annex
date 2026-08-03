import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { LoginPage } from "./LoginPage";
import { consumePendingOAuthNext, storePendingOAuthNext } from "@/lib/pendingOAuth";

// The real Turnstile needs the CF challenge script and DotGrid needs a 2d
// canvas + ResizeObserver - neither exists in jsdom. The Turnstile mock
// verifies on the next tick: LoginPage clears the token in its own
// mount/step effect, which runs after child effects, so a same-tick verify
// would be wiped.
vi.mock("@/components/Turnstile", async () => {
  const React = await import("react");
  return {
    Turnstile: React.forwardRef(function TurnstileMock(
      { onVerify }: { onVerify: (token: string) => void },
      _ref: unknown,
    ) {
      React.useEffect(() => {
        const t = setTimeout(() => onVerify("ts-token"), 0);
        return () => clearTimeout(t);
      }, [onVerify]);
      return null;
    }),
  };
});
vi.mock("@/components/DotGrid", () => ({ DotGrid: () => null }));

const AUTHORIZE_PATH = "/oauth/authorize?client_id=app1&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&code_challenge=abc";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dashboard" element={<div>DASHBOARD</div>} />
        <Route path="/oauth/authorize" element={<div>OAUTH_AUTHORIZE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockLoginSuccess() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ ok: true, data: { token: "jwt-1" } }),
    }),
  );
}

async function signIn() {
  await userEvent.type(screen.getByLabelText(/email/i), "user@example.com");
  await userEvent.type(screen.getByLabelText(/password/i), "hunter2hunter2");
  const submit = screen.getByRole("button", { name: "Sign in" });
  await waitFor(() => expect(submit).toBeEnabled());
  await userEvent.click(submit);
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LoginPage", () => {
  it("lands on the dashboard after sign-in with no next or stash", async () => {
    mockLoginSuccess();
    renderAt("/login");
    await signIn();
    await waitFor(() => expect(screen.getByText("DASHBOARD")).toBeInTheDocument());
    expect(window.localStorage.getItem("token")).toBe("jwt-1");
  });

  it("resumes a stashed OAuth authorize flow after sign-in", async () => {
    storePendingOAuthNext(AUTHORIZE_PATH);
    mockLoginSuccess();
    renderAt("/login");
    await signIn();
    await waitFor(() => expect(screen.getByText("OAUTH_AUTHORIZE")).toBeInTheDocument());
  });

  it("prefers an explicit ?next= but still consumes the stash", async () => {
    storePendingOAuthNext(AUTHORIZE_PATH);
    mockLoginSuccess();
    renderAt("/login?next=%2Fdashboard");
    await signIn();
    await waitFor(() => expect(screen.getByText("DASHBOARD")).toBeInTheDocument());
    // consumed on sign-in so it can't redirect a later session
    expect(consumePendingOAuthNext()).toBeNull();
  });

  it("resumes a stashed OAuth flow for an already-signed-in visitor", async () => {
    window.localStorage.setItem("token", "jwt-existing");
    storePendingOAuthNext(AUTHORIZE_PATH);
    renderAt("/login");
    await waitFor(() => expect(screen.getByText("OAUTH_AUTHORIZE")).toBeInTheDocument());
  });
});
