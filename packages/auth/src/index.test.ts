import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";

describe("auth worker routing", () => {
  it("rate-limits OIDC userinfo by direct client IP using OAuth response semantics", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const env = { RATE_LIMITER_OIDC: { limit } } as unknown as Env;
    const request = new Request("https://auth.cubityfir.st/oauth/userinfo", {
      headers: { "CF-Connecting-IP": "203.0.113.8" },
    });

    const response = await worker.fetch(request, env, {} as ExecutionContext);

    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(limit).toHaveBeenCalledWith({ key: "oidc-userinfo:203.0.113.8" });
    expect(await response.json()).toEqual({
      error: "temporarily_unavailable",
      error_description: "rate limit exceeded",
    });
  });
});
