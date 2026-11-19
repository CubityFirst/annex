import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { safeReturnTo, signInUrl, signInErrorMessage, signOut } from "./signIn";

describe("safeReturnTo", () => {
  it("keeps same-origin app paths", () => {
    expect(safeReturnTo("/projects/p1?x=1#h")).toBe("/projects/p1?x=1#h");
  });
  it("rejects anything that could leave the app", () => {
    for (const bad of ["https://evil.test", "//evil.test", "/\\evil.test", "javascript:alert(1)", "", null, undefined]) {
      expect(safeReturnTo(bad)).toBeNull();
    }
  });
});

describe("signInUrl", () => {
  it("builds the API login URL with a safe return path", () => {
    expect(signInUrl("/projects/p1")).toBe("/api/auth/login?return_to=%2Fprojects%2Fp1");
    expect(signInUrl("https://evil.test")).toBe("/api/auth/login");
    expect(signInUrl(null, { prompt: "login" })).toBe("/api/auth/login?prompt=login");
  });
});

describe("signInErrorMessage", () => {
  it("has specific copy for the codes the callback can return, and a generic fallback", () => {
    expect(signInErrorMessage("access_denied")).toMatch(/cancelled/);
    expect(signInErrorMessage("account_disabled")).toMatch(/disabled/);
    expect(signInErrorMessage("login_expired")).toMatch(/try again/);
    expect(signInErrorMessage("whatever")).toMatch(/didn't complete/);
  });
});

describe("signOut", () => {
  const assign = vi.fn();
  beforeEach(() => {
    localStorage.setItem("token", "jwt");
    vi.stubGlobal("location", { ...window.location, assign });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    assign.mockReset();
    localStorage.clear();
  });

  it("revokes the session, clears the token and goes to the identity service's end-session URL", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { logoutUrl: "https://auth.example/oauth/logout?id_token_hint=x" } }));
    vi.stubGlobal("fetch", fetchMock);
    await signOut();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST", headers: { Authorization: "Bearer jwt" } }));
    expect(localStorage.getItem("token")).toBeNull();
    expect(assign).toHaveBeenCalledWith("https://auth.example/oauth/logout?id_token_hint=x");
  });

  it("still clears the local session when the API can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await signOut();
    expect(localStorage.getItem("token")).toBeNull();
    expect(assign).toHaveBeenCalledWith("/");
  });
});
