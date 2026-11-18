import { describe, it, expect } from "vitest";
import * as worker from "./index";

// workerd loads every named export of the main module as an entrypoint; a
// non-handler export (e.g. a string constant) stops the worker from starting
// ("Incorrect type for map entry ...").
describe("worker main module", () => {
  it("exports only handlers and classes", () => {
    for (const [name, value] of Object.entries(worker)) {
      if (name === "default") continue;
      expect(typeof value, name).toBe("function");
    }
  });
});
