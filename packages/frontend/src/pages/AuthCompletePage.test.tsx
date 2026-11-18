import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthCompletePage } from "./AuthCompletePage";

function renderAt(hash: string) {
  window.history.replaceState(null, "", `/auth/complete${hash}`);
  return render(
    <MemoryRouter initialEntries={["/auth/complete"]}>
      <Routes>
        <Route path="/auth/complete" element={<AuthCompletePage />} />
        <Route path="/projects/p1" element={<div>PROJECT P1</div>} />
        <Route path="/dashboard" element={<div>DASHBOARD</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("AuthCompletePage", () => {
  it("redeems the code once, stores the session and goes to the return path", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { token: "session-jwt" } }));
    vi.stubGlobal("fetch", fetchMock);
    renderAt("#code=abc123&return_to=%2Fprojects%2Fp1");
    expect(await screen.findByText("PROJECT P1")).toBeInTheDocument();
    expect(localStorage.getItem("token")).toBe("session-jwt");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1] && ((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body))).toEqual({ code: "abc123" });
    // The code doesn't linger in the address bar.
    expect(window.location.hash).toBe("");
  });

  it("ignores an off-site return path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { token: "t" } })));
    renderAt("#code=abc123&return_to=https%3A%2F%2Fevil.test");
    expect(await screen.findByText("DASHBOARD")).toBeInTheDocument();
  });

  it("explains a callback error and offers a retry", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderAt("#error=access_denied");
    expect(await screen.findByText(/sign-in was cancelled/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains a code that was already used or expired", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error: "invalid_code" }, { status: 400 })));
    renderAt("#code=used");
    await waitFor(() => expect(screen.getByText(/took too long or was already used/i)).toBeInTheDocument());
    expect(localStorage.getItem("token")).toBeNull();
  });
});
