import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthCallbackPage } from "./AuthCallbackPage";
import { getToken } from "@/lib/auth";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  window.sessionStorage.clear();
});

// Uses the REAL api module (fetch stubbed), so the per-code exchange promise
// cache is part of what's under test.
function renderCallback(code: string, onAuthenticated = vi.fn()) {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={[`/auth/callback?code=${code}`]}>
        <Routes>
          <Route path="/auth/callback" element={<AuthCallbackPage onAuthenticated={onAuthenticated} />} />
          <Route path="/" element={<div>HOME</div>} />
          <Route path="/audit" element={<div>AUDIT</div>} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  );
  return onAuthenticated;
}

describe("AuthCallbackPage", () => {
  it("exchanges the code ONCE despite StrictMode's dev double-mount (AF-C3), stores the token, navigates", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, data: { token: "minted-token" } }));
    const onAuthenticated = renderCallback("cb-success");

    await waitFor(() => expect(screen.getByText("HOME")).toBeInTheDocument());
    // Single-use code: the double-mounted effect must not consume it twice.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getToken()).toBe("minted-token");
    expect(onAuthenticated).toHaveBeenCalled();
    // And no error painted over the successful sign-in.
    expect(screen.queryByText(/expired or failed/)).not.toBeInTheDocument();
  });

  it("strips the one-time code from the address before exchanging", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, data: { token: "t" } }));
    renderCallback("cb-strip");
    await waitFor(() => expect(replaceState).toHaveBeenCalled());
    const strippedUrl = String(replaceState.mock.calls[0][2]);
    expect(strippedUrl).not.toContain("cb-strip");
    replaceState.mockRestore();
  });

  it("shows the not-an-admin message for the not_admin error", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: false, error: "not_admin" }, 403));
    renderCallback("cb-not-admin");
    await waitFor(() =>
      expect(screen.getByText(/does not have admin access/)).toBeInTheDocument(),
    );
  });

  it("shows the generic message for a consumed/expired code", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: false, error: "Unauthorized" }, 401));
    renderCallback("cb-consumed");
    await waitFor(() =>
      expect(screen.getByText(/expired or failed/)).toBeInTheDocument(),
    );
  });

  it("errors immediately when the code is missing", async () => {
    render(
      <MemoryRouter initialEntries={["/auth/callback"]}>
        <Routes>
          <Route path="/auth/callback" element={<AuthCallbackPage onAuthenticated={vi.fn()} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/missing a code/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
