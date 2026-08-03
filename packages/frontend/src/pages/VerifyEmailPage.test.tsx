import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { VerifyEmailPage } from "./VerifyEmailPage";
import { consumePendingOAuthNext, storePendingOAuthNext } from "@/lib/pendingOAuth";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/dashboard" element={<div>DASHBOARD</div>} />
        <Route path="/login" element={<div>LOGIN</div>} />
        <Route path="/oauth/authorize" element={<div>OAUTH_AUTHORIZE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockFetchOnce(json: unknown) {
  return vi.fn().mockResolvedValue({ json: () => Promise.resolve(json) });
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("VerifyEmailPage", () => {
  it("shows the failure/resend UI when there is no token", () => {
    renderAt("/verify-email");
    expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
  });

  it("verifies and redirects to the dashboard when a session token comes back", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ ok: true, data: { verified: true, token: "jwt-123" } }));
    renderAt("/verify-email?token=good");
    await waitFor(() => expect(screen.getByText("DASHBOARD")).toBeInTheDocument());
    // the returned JWT was persisted
    expect(window.localStorage.getItem("token")).toBe("jwt-123");
  });

  it("resumes a stashed OAuth authorize flow after signup verification", async () => {
    storePendingOAuthNext("/oauth/authorize?client_id=app1&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&code_challenge=abc");
    vi.stubGlobal("fetch", mockFetchOnce({ ok: true, data: { verified: true, token: "jwt-123" } }));
    renderAt("/verify-email?token=good");
    await waitFor(() => expect(screen.getByText("OAUTH_AUTHORIZE")).toBeInTheDocument());
    // the stash is single-use - it was consumed by the redirect
    expect(consumePendingOAuthNext()).toBeNull();
  });

  it("shows the success state when verified without an auto-login token", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ ok: true, data: { verified: true } }));
    renderAt("/verify-email?token=good");
    expect(await screen.findByText(/your email has been verified/i)).toBeInTheDocument();
  });

  it("shows the failure state when the token is rejected", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ ok: false, error: "invalid_or_expired_token" }));
    renderAt("/verify-email?token=bad");
    expect(await screen.findByText(/invalid or has expired/i)).toBeInTheDocument();
  });

  it("shows the email-updated state for a change-confirm link without logging in", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ ok: true, data: { verified: true, emailChanged: true, userId: "u1", email: "new@example.com" } }));
    renderAt("/verify-email?token=change");
    expect(await screen.findByText(/your email address has been updated/i)).toBeInTheDocument();
    // No session is minted from a change-confirm link.
    expect(window.localStorage.getItem("token")).toBeNull();
    expect(screen.queryByText("DASHBOARD")).not.toBeInTheDocument();
  });

  it("shows the expired-change state pointing back to settings, without the resend form", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ ok: false, error: "change_link_expired" }));
    renderAt("/verify-email?token=stale");
    expect(await screen.findByText(/request the change again from your account settings/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
  });

  it("shows the email-taken state without the signup resend form", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ ok: false, error: "email_taken" }));
    renderAt("/verify-email?token=change");
    expect(await screen.findByText(/claimed by another account/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /resend verification email/i })).not.toBeInTheDocument();
  });

  it("resends a verification email from the failure state", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/verify-email");

    await userEvent.type(screen.getByLabelText(/email address/i), "user@example.com");
    await userEvent.click(screen.getByRole("button", { name: /resend verification email/i }));

    expect(await screen.findByText(/verification email sent/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/verify-email/resend", expect.objectContaining({ method: "POST" }));
  });
});
