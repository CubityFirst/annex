import { describe, it, expect } from "vitest";
import { clientIp, normalizeEmail } from "./lib";

describe("normalizeEmail", () => {
  it("strips leading and trailing whitespace", () => {
    expect(normalizeEmail("  user@example.com  ")).toBe("user@example.com");
  });

  it("strips tabs and newlines as well as spaces", () => {
    expect(normalizeEmail("\tuser@example.com\n")).toBe("user@example.com");
  });

  it("lowercases the address", () => {
    expect(normalizeEmail("User@Example.COM")).toBe("user@example.com");
  });

  it("trims and lowercases together so register and login resolve identically", () => {
    expect(normalizeEmail("  User@Example.com ")).toBe(normalizeEmail("user@example.com"));
  });

  it("returns empty string for a whitespace-only input (caller rejects it)", () => {
    expect(normalizeEmail("   ")).toBe("");
  });

  it("leaves interior characters untouched (only edges are trimmed)", () => {
    expect(normalizeEmail("a.b+tag@sub.example.com")).toBe("a.b+tag@sub.example.com");
  });
});

describe("clientIp", () => {
  const req = (headers: Record<string, string>) =>
    new Request("https://auth/login", { headers });

  it("prefers the edge-set CF-Connecting-IP when present", () => {
    expect(clientIp(req({ "CF-Connecting-IP": "1.2.3.4", "X-Client-IP": "5.6.7.8" })))
      .toBe("1.2.3.4");
  });

  it("falls back to the proxy-forwarded X-Client-IP on service-binding hops", () => {
    expect(clientIp(req({ "X-Client-IP": "5.6.7.8" }))).toBe("5.6.7.8");
  });

  it("returns null when neither header is present", () => {
    expect(clientIp(req({}))).toBeNull();
  });
});
