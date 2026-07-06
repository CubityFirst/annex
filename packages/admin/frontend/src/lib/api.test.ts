import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TransientVerifyError,
  exchangeAdminHandoff,
  getUserDetails,
  getProjectDetails,
  verifyAdminSession,
} from "./api";
import { ADMIN_AUTH_INVALIDATED_EVENT, setToken, getToken } from "./auth";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;
let invalidated: number;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  window.sessionStorage.clear();
  setToken("tok");
  invalidated = 0;
  window.addEventListener(ADMIN_AUTH_INVALIDATED_EVENT, () => invalidated++);
});

describe("authFetch session-invalidation matrix", () => {
  it("401 invalidates the admin session", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: "Unauthorized" }, 401));
    await expect(getUserDetails("u-1")).rejects.toThrow();
    expect(getToken()).toBeNull();
    expect(invalidated).toBe(1);
  });

  it.each(["Forbidden", "account_disabled", "account_suspended"])(
    "403 %s invalidates the session",
    async (code) => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: code }, 403));
      await expect(getUserDetails("u-1")).rejects.toThrow();
      expect(getToken()).toBeNull();
    },
  );

  it("a generic 403 (per-object denial) must NOT log the operator out", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: "some_future_denial" }, 403));
    await expect(getUserDetails("u-1")).rejects.toThrow("some_future_denial");
    expect(getToken()).toBe("tok");
    expect(invalidated).toBe(0);
  });

  it("429 maps to a readable rate-limit message and keeps the session", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: "rate_limited" }, 429));
    await expect(getUserDetails("u-1")).rejects.toThrow(/rate limit/i);
    expect(getToken()).toBe("tok");
  });
});

describe("readData envelope guard (AF-C4)", () => {
  it("surfaces the HTTP status for a non-JSON body instead of a SyntaxError", async () => {
    fetchMock.mockResolvedValue(new Response("<html>SPA shell</html>", { status: 500 }));
    await expect(getProjectDetails("p-1")).rejects.toThrow("HTTP 500");
  });

  it("throws the server's error string from the envelope", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: "Not found" }, 404));
    await expect(getProjectDetails("p-1")).rejects.toThrow("Not found");
  });
});

describe("verifyAdminSession transient-vs-fatal split (AF-C6)", () => {
  it("wraps network failures in TransientVerifyError", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(verifyAdminSession()).rejects.toBeInstanceOf(TransientVerifyError);
    // A network blip must not clear the token.
    expect(getToken()).toBe("tok");
  });

  it("wraps 5xx responses in TransientVerifyError", async () => {
    fetchMock.mockResolvedValue(new Response("bad gateway", { status: 502 }));
    await expect(verifyAdminSession()).rejects.toBeInstanceOf(TransientVerifyError);
  });

  it("a 401 stays a fatal (non-transient) failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: "Unauthorized" }, 401));
    const err = await verifyAdminSession().catch(e => e);
    expect(err).not.toBeInstanceOf(TransientVerifyError);
  });
});

describe("exchangeAdminHandoff promise cache (AF-C3)", () => {
  it("two concurrent exchanges of the same code share ONE network call and outcome", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { token: "minted" } }));
    const [a, b] = await Promise.all([
      exchangeAdminHandoff("dm-code-1", "https://admin.example/auth/callback"),
      exchangeAdminHandoff("dm-code-1", "https://admin.example/auth/callback"),
    ]);
    expect(a.token).toBe("minted");
    expect(b.token).toBe("minted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("different codes do not share the cache", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, data: { token: "minted" } }));
    await exchangeAdminHandoff("dm-code-2", "https://admin.example/auth/callback");
    await exchangeAdminHandoff("dm-code-3", "https://admin.example/auth/callback");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
