import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { OAuthAuthorizePage } from "./OAuthAuthorizePage";
import { consumePendingOAuthNext, storePendingOAuthNext } from "@/lib/pendingOAuth";

const VALID_QUERY =
  "?client_id=app1&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&code_challenge=abc&code_challenge_method=S256&scope=openid+email&state=xyz";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/oauth/authorize" element={<OAuthAuthorizePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

let assignMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  assignMock = vi.fn();
  // jsdom's real navigation isn't implemented; replace assign with a spy so we
  // can assert the page-driven redirects (login bounce + final redirectTo).
  Object.defineProperty(window, "location", {
    value: { assign: assignMock, href: "http://localhost/", origin: "http://localhost", pathname: "/", search: "" },
    writable: true,
    configurable: true,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("OAuthAuthorizePage", () => {
  it("shows an error when required OIDC params are missing", async () => {
    window.localStorage.setItem("token", "jwt");
    renderAt("/oauth/authorize?client_id=app1"); // no redirect_uri / code_challenge
    expect(await screen.findByText(/sign-in request was incomplete/i)).toBeInTheDocument();
  });

  it("bounces to login when there is no session token", () => {
    renderAt(`/oauth/authorize${VALID_QUERY}`);
    expect(assignMock).toHaveBeenCalledWith(expect.stringMatching(/^\/login\?next=/));
  });

  it("stashes the authorize URL before bouncing so a signup detour can resume", () => {
    renderAt(`/oauth/authorize${VALID_QUERY}`);
    expect(consumePendingOAuthNext()).toBe(`/oauth/authorize${VALID_QUERY}`);
  });

  it("renders the consent screen with the client name and scopes", async () => {
    window.localStorage.setItem("token", "jwt");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        json: () =>
          Promise.resolve({
            ok: true,
            data: {
              consentRequired: true,
              client: { name: "Demo App" },
              scope: "openid email",
              email: "user@example.com",
            },
          }),
      }),
    );
    renderAt(`/oauth/authorize${VALID_QUERY}`);

    expect(await screen.findByText("Demo App")).toBeInTheDocument();
    expect(screen.getByText("user@example.com")).toBeInTheDocument();
    expect(screen.getByText(/confirm your identity/i)).toBeInTheDocument();
    expect(screen.getByText(/your email address/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /allow/i })).toBeInTheDocument();
  });

  it("approves consent and follows the returned redirect", async () => {
    window.localStorage.setItem("token", "jwt");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: () =>
          Promise.resolve({
            ok: true,
            data: { consentRequired: true, client: { name: "Demo App" }, scope: "openid", email: "u@e.com" },
          }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ ok: true, data: { redirectTo: "https://app.example/cb?code=zzz" } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    renderAt(`/oauth/authorize${VALID_QUERY}`);

    await userEvent.click(await screen.findByRole("button", { name: /allow/i }));

    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("https://app.example/cb?code=zzz"));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/oauth/authorize",
      expect.objectContaining({ body: expect.stringContaining('"approved":true') }),
    );
  });

  it("clears a leftover stash when the flow completes with a redirect", async () => {
    window.localStorage.setItem("token", "jwt");
    storePendingOAuthNext(`/oauth/authorize${VALID_QUERY}`);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        json: () => Promise.resolve({ ok: true, data: { redirectTo: "https://app.example/cb?code=zzz" } }),
      }),
    );
    renderAt(`/oauth/authorize${VALID_QUERY}`);

    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("https://app.example/cb?code=zzz"));
    expect(consumePendingOAuthNext()).toBeNull();
  });

  it("denies consent and follows the returned redirect", async () => {
    window.localStorage.setItem("token", "jwt");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: () =>
          Promise.resolve({
            ok: true,
            data: { consentRequired: true, client: { name: "Demo App" }, scope: "openid", email: "u@e.com" },
          }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ ok: true, data: { redirectTo: "https://app.example/cb?error=access_denied" } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    renderAt(`/oauth/authorize${VALID_QUERY}`);

    await userEvent.click(await screen.findByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("https://app.example/cb?error=access_denied"));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/oauth/authorize",
      expect.objectContaining({ body: expect.stringContaining('"denied":true') }),
    );
  });

  it("maps a known server error code to a friendly message", async () => {
    window.localStorage.setItem("token", "jwt");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        json: () => Promise.resolve({ ok: false, error: "invalid_client" }),
      }),
    );
    renderAt(`/oauth/authorize${VALID_QUERY}`);
    expect(await screen.findByText(/isn't recognised/i)).toBeInTheDocument();
  });

  it("re-authenticates on a 401 response", async () => {
    window.localStorage.setItem("token", "jwt");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401, json: () => Promise.resolve({}) }));
    renderAt(`/oauth/authorize${VALID_QUERY}`);

    await waitFor(() => expect(assignMock).toHaveBeenCalledWith(expect.stringMatching(/^\/login\?next=/)));
    expect(window.localStorage.getItem("token")).toBeNull();
  });

  it("shows a connection error when the request throws", async () => {
    window.localStorage.setItem("token", "jwt");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    renderAt(`/oauth/authorize${VALID_QUERY}`);
    expect(await screen.findByText(/couldn't reach annex/i)).toBeInTheDocument();
  });
});
