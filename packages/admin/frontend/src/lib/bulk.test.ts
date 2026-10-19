import { describe, expect, it, vi } from "vitest";
import { RateLimitedError } from "@/lib/api";
import { runBulk } from "@/lib/bulk";

const noSleep = () => Promise.resolve();

describe("runBulk", () => {
  it("runs sequentially and reports progress", async () => {
    const order: string[] = [];
    const progress: Array<[number, number]> = [];
    const result = await runBulk(["a", "b", "c"], async id => { order.push(id); }, {
      sleep: noSleep,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(order).toEqual(["a", "b", "c"]);
    expect(result).toEqual({ succeeded: ["a", "b", "c"], failed: [] });
    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it("records a failure and keeps going", async () => {
    const result = await runBulk(["a", "b"], async id => {
      if (id === "a") throw new Error("nope");
    }, { sleep: noSleep });
    expect(result).toEqual({ succeeded: ["b"], failed: [{ id: "a", error: "nope" }] });
  });

  it("waits and retries a rate-limited call", async () => {
    const sleep = vi.fn(noSleep);
    let calls = 0;
    const result = await runBulk(["a"], async () => {
      calls++;
      if (calls < 3) throw new RateLimitedError();
    }, { sleep, retryDelayMs: 10 });
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(result.succeeded).toEqual(["a"]);
  });

  it("gives up after maxRetries rate-limit hits", async () => {
    const action = vi.fn(async () => { throw new RateLimitedError(); });
    const result = await runBulk(["a"], action, { sleep: noSleep, maxRetries: 2 });
    expect(action).toHaveBeenCalledTimes(3);
    expect(result.failed).toHaveLength(1);
  });
});
