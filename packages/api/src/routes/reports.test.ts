import { describe, it, expect, vi } from "vitest";
import { handleUserReport } from "./reports";
import { MAX_REPORT_NOTE_LENGTH } from "./public";
import type { Env } from "../index";
import type { Session } from "../lib";

const SESSION = { userId: "user-reporter", email: "r@example.com" } as Session;

interface PreparedCall {
  sql: string;
  binds: unknown[];
}

// Handler order: AUTH_DB target-user lookup (.first), then the DB insert
// (.run). Each prepared statement records its SQL + binds.
function makeEnv(opts: { targetExists?: boolean; limiterSuccess?: boolean; hasLimiter?: boolean } = {}) {
  const calls: PreparedCall[] = [];
  function makeStmt(sql: string, firstResult: unknown) {
    const call: PreparedCall = { sql, binds: [] };
    const stmt = {
      bind: (...args: unknown[]) => {
        call.binds = args;
        return stmt;
      },
      first: async () => {
        calls.push(call);
        return firstResult;
      },
      run: async () => {
        calls.push(call);
        return { meta: { changes: 1 } };
      },
    };
    return stmt;
  }
  const limit = vi.fn().mockResolvedValue({ success: opts.limiterSuccess ?? true });
  const env = {
    AUTH_DB: { prepare: vi.fn((sql: string) => makeStmt(sql, (opts.targetExists ?? true) ? { id: "user-target" } : null)) },
    DB: { prepare: vi.fn((sql: string) => makeStmt(sql, null)) },
    ...(opts.hasLimiter === false ? {} : { RATE_LIMITER_REPORT: { limit } }),
  } as unknown as Env;
  return { env, calls, limit };
}

function reportRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/users/user-target/report", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /users/:userId/report", () => {
  it("files a report attributed to the signed-in caller", async () => {
    const { env, calls, limit } = makeEnv();
    const res = await handleUserReport(
      reportRequest({ note: "  Harassing members in comments.  " }, { "CF-Connecting-IP": "203.0.113.9" }),
      env, SESSION, "user-target",
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, data: { submitted: true } });

    // Limiter keyed by the reporting user, not the IP.
    expect(limit).toHaveBeenCalledWith({ key: "report:user:user-reporter" });
    // Target existence check hits the auth DB.
    expect(calls[0].sql).toContain("FROM users WHERE id = ?");
    expect(calls[0].binds).toEqual(["user-target"]);
    // Insert: trimmed note, reporter attribution, edge IP captured.
    expect(calls[1].sql).toContain("INSERT INTO user_reports");
    const [, reportedId, reporterId, ip, note] = calls[1].binds;
    expect(reportedId).toBe("user-target");
    expect(reporterId).toBe("user-reporter");
    expect(ip).toBe("203.0.113.9");
    expect(note).toBe("Harassing members in comments.");
  });

  it("400s when reporting yourself", async () => {
    const { env, calls } = makeEnv();
    const res = await handleUserReport(reportRequest({ note: "hm" }), env, SESSION, SESSION.userId);
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  it("400s on a missing, empty, or oversized note", async () => {
    for (const body of [{}, { note: "   " }, { note: "x".repeat(MAX_REPORT_NOTE_LENGTH + 1) }]) {
      const { env, calls } = makeEnv();
      const res = await handleUserReport(reportRequest(body), env, SESSION, "user-target");
      expect(res.status).toBe(400);
      expect(calls.some(c => c.sql.includes("INSERT"))).toBe(false);
    }
  });

  it("404s when the reported user does not exist", async () => {
    const { env, calls } = makeEnv({ targetExists: false });
    const res = await handleUserReport(reportRequest({ note: "report" }), env, SESSION, "user-gone");
    expect(res.status).toBe(404);
    expect(calls.some(c => c.sql.includes("INSERT"))).toBe(false);
  });

  it("429s when the per-user limiter trips, before touching either DB", async () => {
    const { env, calls } = makeEnv({ limiterSuccess: false });
    const res = await handleUserReport(reportRequest({ note: "report" }), env, SESSION, "user-target");
    expect(res.status).toBe(429);
    expect(calls.length).toBe(0);
  });

  it("fails open when the limiter binding is absent (local dev)", async () => {
    const { env } = makeEnv({ hasLimiter: false });
    const res = await handleUserReport(reportRequest({ note: "report" }), env, SESSION, "user-target");
    expect(res.status).toBe(201);
  });
});
