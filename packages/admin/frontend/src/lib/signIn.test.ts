import { describe, it, expect } from "vitest";
import { adminSignInUrl, normalizeAdminNextPath, signInErrorMessage } from "./signIn";

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

  it("rejects protocol-relative forms (AF-S6)", () => {
    expect(normalizeAdminNextPath("//evil.com")).toBe("/");
    expect(normalizeAdminNextPath("/\\evil.com")).toBe("/");
  });
});

describe("adminSignInUrl", () => {
  it("points at the admin worker's login route with a safe return path", () => {
    expect(adminSignInUrl("/")).toBe("/api/auth/login");
    expect(adminSignInUrl("/audit")).toBe("/api/auth/login?return_to=%2Faudit");
    expect(adminSignInUrl("//evil.com")).toBe("/api/auth/login");
    expect(adminSignInUrl("/", { prompt: "login" })).toBe("/api/auth/login?prompt=login");
  });
});

describe("signInErrorMessage", () => {
  it("explains a missing admin role", () => {
    expect(signInErrorMessage("not_admin")).toMatch(/admin access/);
    expect(signInErrorMessage("whatever")).toMatch(/didn't complete/);
  });
});
