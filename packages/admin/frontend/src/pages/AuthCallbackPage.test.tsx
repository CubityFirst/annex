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

// /api/auth/callback hands the outcome over in the URL fragment of the real
// window location. Uses the REAL api module (fetch stubbed), so the per-code
// exchange promise cache is part of what's under test.
function renderComplete(fragment: string, onAuthenticated = vi.fn()) {
  window.history.replaceState(null, "", `/auth/complete#${fragment}`);
  render(
    <StrictMode>
      <MemoryRouter initialEntries={["/auth/complete"]}>
        <Routes>
          <Route path="/auth/complete" element={<AuthCallbackPage onAuthenticated={onAuthenticated} />} />
          <Route path="/" element={<div>HOME</div>} />
          <Route path="/audit" element={<div>AUDIT</div>} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  );
  return onAuthenticated;
}

describe("AuthCallbackPage (/auth/complete)", () => {
  it("exchanges the code ONCE despite StrictMode's dev double-mount (AF-C3), stores the token, navigates", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, data: { token: "minted-token" } }));
    const onAuthenticated = renderComplete("code=cb-success");

    await waitFor(() => expect(screen.getByText("HOME")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/exchange", expect.objectContaining({ method: "POST", body: JSON.stringify({ code: "cb-success" }) }));
    expect(getToken()).toBe("minted-token");
    expect(onAuthenticated).toHaveBeenCalled();
    expect(screen.queryByText(/didn't complete/)).not.toBeInTheDocument();
  });

  it("goes to the return path carried in the fragment, but never off-site", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, data: { token: "t" } }));
    renderComplete("code=cb-next&return_to=%2Faudit");
    await waitFor(() => expect(screen.getByText("AUDIT")).toBeInTheDocument());
  });

  it("strips the one-time code from the address bar", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, data: { token: "t" } }));
    renderComplete("code=cb-strip");
    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(window.location.href).not.toContain("cb-strip");
  });

  it("explains a missing admin role and offers a fresh sign-in", async () => {
    renderComplete("error=not_admin");
    expect(await screen.findByText(/does not have admin access/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /try again/i })).toHaveAttribute("href", "/api/auth/login?prompt=login");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains a consumed/expired code", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: false, error: "invalid_code" }, 400));
    renderComplete("code=cb-consumed");
    expect(await screen.findByText(/took too long or was already used/)).toBeInTheDocument();
    expect(getToken()).toBeNull();
  });
});
