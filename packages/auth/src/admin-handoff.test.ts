import { describe, it, expect, vi } from "vitest";
import { normalizeAdminCallbackUrl, normalizeNextPath, writeAdminHandoffAudit } from "./admin-handoff";
import type { Env } from "./index";

const PROD_ENV = {
  ADMIN_APP_ORIGIN: "https://admin.cubityfir.st",
  APP_ORIGIN: "https://docs.cubityfir.st",
} as Env;

const DEV_ENV = {
  ADMIN_APP_ORIGIN: "https://admin.cubityfir.st",
  APP_ORIGIN: "http://localhost:5173",
} as Env;

describe("normalizeNextPath", () => {
  it("passes plain absolute paths", () => {
    expect(normalizeNextPath("/audit")).toBe("/audit");
  });
  it("rejects non-absolute paths", () => {
    expect(normalizeNextPath("audit")).toBeNull();
    expect(normalizeNextPath("https://evil.com")).toBeNull();
  });
  it("rejects protocol-relative forms (AF-S6 twin)", () => {
    expect(normalizeNextPath("//evil.com")).toBeNull();
    expect(normalizeNextPath("/\\evil.com")).toBeNull();
  });
});

describe("normalizeAdminCallbackUrl", () => {
  it("accepts the production admin origin", () => {
    expect(normalizeAdminCallbackUrl("https://admin.cubityfir.st/auth/callback", PROD_ENV))
      .toBe("https://admin.cubityfir.st/auth/callback");
  });

  it("rejects a // next path even on the production origin", () => {
    expect(
      normalizeAdminCallbackUrl("https://admin.cubityfir.st/auth/callback?next=%2F%2Fevil.com", PROD_ENV),
    ).toBeNull();
  });

  it("REFUSES localhost callback origins on a production deployment (AB-M6)", () => {
    expect(normalizeAdminCallbackUrl("http://localhost:5174/auth/callback", PROD_ENV)).toBeNull();
    expect(normalizeAdminCallbackUrl("http://127.0.0.1:5174/auth/callback", PROD_ENV)).toBeNull();
  });

  it("allows localhost callback origins only when the deployment itself is local", () => {
    expect(normalizeAdminCallbackUrl("http://localhost:5174/auth/callback", DEV_ENV))
      .toBe("http://localhost:5174/auth/callback");
  });

  it("still rejects arbitrary origins on a local deployment", () => {
    expect(normalizeAdminCallbackUrl("https://evil.com/auth/callback", DEV_ENV)).toBeNull();
  });
});

describe("writeAdminHandoffAudit", () => {
  it("writes an actor-attributed admin_audit_log row targeting the actor", async () => {
    const binds: unknown[][] = [];
    const stmt = {
      bind: (...args: unknown[]) => {
        binds.push(args);
        return stmt;
      },
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
    };
    const env = { DB: { prepare: vi.fn(() => stmt) } } as unknown as Env;

    await writeAdminHandoffAudit(env, { userId: "u-1", email: "a@x.com" }, "admin.handoff.exchange", { sessionId: "s-1" });

    const prepare = (env.DB.prepare as ReturnType<typeof vi.fn>);
    expect(prepare.mock.calls[0][0]).toContain("INSERT INTO admin_audit_log");
    const [, actorId, actorEmail, action, targetId, detail] = binds[0];
    expect(actorId).toBe("u-1");
    expect(actorEmail).toBe("a@x.com");
    expect(action).toBe("admin.handoff.exchange");
    expect(targetId).toBe("u-1");
    expect(JSON.parse(detail as string)).toEqual({ sessionId: "s-1" });
  });
});
