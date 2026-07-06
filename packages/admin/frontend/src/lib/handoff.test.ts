import { describe, it, expect } from "vitest";
import { buildAdminCallbackUrl, buildDocsAdminLoginUrl, normalizeAdminNextPath } from "./handoff";

describe("normalizeAdminNextPath", () => {
  it("defaults to / for missing or relative values", () => {
    expect(normalizeAdminNextPath(null)).toBe("/");
    expect(normalizeAdminNextPath(undefined)).toBe("/");
    expect(normalizeAdminNextPath("")).toBe("/");
    expect(normalizeAdminNextPath("audit")).toBe("/");
    expect(normalizeAdminNextPath("https://evil.com")).toBe("/");
  });

  it("passes plain absolute paths through", () => {
    expect(normalizeAdminNextPath("/audit")).toBe("/audit");
    expect(normalizeAdminNextPath("/projects?q=x")).toBe("/projects?q=x");
  });

  it("rejects protocol-relative forms that would wedge the callback page (AF-S6)", () => {
    expect(normalizeAdminNextPath("//evil.com")).toBe("/");
    expect(normalizeAdminNextPath("/\\evil.com")).toBe("/");
  });
});

describe("buildAdminCallbackUrl", () => {
  it("builds the callback on the given origin without a next for /", () => {
    expect(buildAdminCallbackUrl("/", "https://admin.example")).toBe("https://admin.example/auth/callback");
  });

  it("carries a non-root next path", () => {
    const url = new URL(buildAdminCallbackUrl("/audit", "https://admin.example"));
    expect(url.pathname).toBe("/auth/callback");
    expect(url.searchParams.get("next")).toBe("/audit");
  });

  it("normalizes malicious next paths away", () => {
    const url = new URL(buildAdminCallbackUrl("//evil.com", "https://admin.example"));
    expect(url.searchParams.get("next")).toBeNull();
  });
});

describe("buildDocsAdminLoginUrl", () => {
  it("points at the docs login with returnTo set to the callback", () => {
    const url = new URL(buildDocsAdminLoginUrl("/audit", { origin: "https://admin.example" }));
    expect(url.pathname).toBe("/login");
    const returnTo = new URL(url.searchParams.get("returnTo")!);
    expect(returnTo.origin).toBe("https://admin.example");
    expect(returnTo.pathname).toBe("/auth/callback");
  });

  it("adds logout=1 when requested", () => {
    const url = new URL(buildDocsAdminLoginUrl("/", { logout: true, origin: "https://admin.example" }));
    expect(url.searchParams.get("logout")).toBe("1");
  });
});
