import { describe, it, expect } from "vitest";
import { normalizeHandle, handleProblem, profilePath } from "./handle";
import * as server from "../../../auth/src/handle";

// The client copy only drives hints, but a drift would show "looks good" for a
// name the server then rejects (or vice versa), so pin them together.
const SAMPLES = [
  "abc", "a-b_c", "user123", "9lives", "x".repeat(30), "x".repeat(31), "ab",
  "has space", "dot.ted", "Upper", "-lead", "trail_", "a/b", "admin", "support",
  "staff", "me", "admin2", "@cubity", "  Cubity  ", "",
];

describe("handle rules", () => {
  it("match the auth worker's rules", () => {
    for (const raw of SAMPLES) {
      const n = normalizeHandle(raw);
      expect(n, raw).toBe(server.normalizeHandle(raw));
      expect(handleProblem(n), raw).toBe(server.handleProblem(n));
    }
  });

  it("profilePath prefers the vanity link", () => {
    expect(profilePath("u1", "cubity")).toBe("/@cubity");
    expect(profilePath("u1", null)).toBe("/u/u1");
    expect(profilePath("u1")).toBe("/u/u1");
  });
});
