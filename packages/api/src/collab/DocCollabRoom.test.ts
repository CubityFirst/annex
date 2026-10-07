import { describe, it, expect } from "vitest";
import { DocCollabRoom, sessionStillValid } from "./DocCollabRoom";

// Unit tests for the in-DO access re-check (revalidateAccess): an open collab
// socket is authorized only once at upgrade, so the room re-resolves effective
// access on incoming traffic and closes any socket that no longer has editor+
// (member removed/demoted, org membership revoked, org deleted). These exercise
// that sweep directly with stubbed sockets + DB, without a live Durable Object.

// Per-user D1 stub matching resolveAccess's single prepare().bind(uid,uid,projId).first().
// `roles[uid]` undefined => no membership (null row); "throw" => simulate a DB error.
function dbForRoles(roles: Record<string, { project: string | null; org: string | null } | "throw">) {
  const calls = { first: 0 };
  const db = {
    prepare: () => ({
      bind: (uid: string) => ({
        first: async () => {
          calls.first++;
          const r = roles[uid];
          if (r === "throw") throw new Error("db boom");
          if (!r) return { project_role: null, project_name: null, org_role: null, org_name: null };
          return {
            project_role: r.project, project_name: r.project ? "n" : null,
            org_role: r.org, org_name: r.org ? "n" : null,
          };
        },
      }),
    }),
  };
  return { db: db as unknown as D1Database, calls };
}

interface FakeWs {
  closedWith: { code: number; reason: string } | null;
  deserializeAttachment: () => { userId: string; userName: string; clientId: number; sid?: string };
  close: (code: number, reason: string) => void;
}
function fakeWs(userId: string, sid?: string): FakeWs {
  const ws: FakeWs = {
    closedWith: null,
    deserializeAttachment: () => ({ userId, userName: userId, clientId: 1, sid }),
    close: (code, reason) => { ws.closedWith = { code, reason }; },
  };
  return ws;
}

function makeRoom(sockets: FakeWs[], db: D1Database, authDb?: D1Database): { revalidateAccess(): Promise<Set<string>> } {
  const ctx = {
    getWebSockets: () => sockets,
    storage: { get: async (k: string) => (k === "docKey" ? "proj-1/doc-1" : undefined) },
  };
  const room = new DocCollabRoom(
    ctx as unknown as ConstructorParameters<typeof DocCollabRoom>[0],
    { DB: db, AUTH_DB: authDb } as unknown as ConstructorParameters<typeof DocCollabRoom>[1],
  );
  return room as unknown as { revalidateAccess(): Promise<Set<string>> };
}

describe("DocCollabRoom.revalidateAccess (closes sockets that lost editor+)", () => {
  it("keeps editor+ (direct or via org) and closes viewer / removed users with 1008", async () => {
    const direct = fakeWs("direct-editor");
    const orgEd = fakeWs("org-editor");
    const orgViewer = fakeWs("org-viewer");
    const gone = fakeWs("gone");
    const { db } = dbForRoles({
      "direct-editor": { project: "editor", org: null },
      "org-editor": { project: null, org: "editor" },   // trickle-down editor - keep
      "org-viewer": { project: null, org: "viewer" },    // below editor - close
      // "gone": absent => no membership => close
    });

    const room = makeRoom([direct, orgEd, orgViewer, gone], db);
    const revoked = await room.revalidateAccess();

    expect(direct.closedWith).toBeNull();
    expect(orgEd.closedWith).toBeNull();
    expect(orgViewer.closedWith).toEqual({ code: 1008, reason: "access revoked" });
    expect(gone.closedWith).toEqual({ code: 1008, reason: "access revoked" });
    expect([...revoked].sort()).toEqual(["gone", "org-viewer"]);
  });

  it("de-dups by userId - duplicate sockets for one user cost a single resolver read", async () => {
    const a = fakeWs("gone");
    const b = fakeWs("gone");
    const { db, calls } = dbForRoles({});
    const room = makeRoom([a, b], db);

    const revoked = await room.revalidateAccess();
    expect(calls.first).toBe(1);
    expect(a.closedWith).toEqual({ code: 1008, reason: "access revoked" });
    expect(b.closedWith).toEqual({ code: 1008, reason: "access revoked" });
    expect([...revoked]).toEqual(["gone"]);
  });

  it("throttles - a second immediate sweep is a no-op (no query, no re-close)", async () => {
    const gone = fakeWs("gone");
    const { db, calls } = dbForRoles({});
    const room = makeRoom([gone], db);

    await room.revalidateAccess();
    expect(calls.first).toBe(1);
    gone.closedWith = null; // reset to detect a (wrong) second close

    const second = await room.revalidateAccess();
    expect(second.size).toBe(0);
    expect(calls.first).toBe(1);     // throttled - did not query again
    expect(gone.closedWith).toBeNull();
  });

  it("fails open on a resolver/DB error - does not tear down a live session", async () => {
    const boom = fakeWs("boom");
    const { db } = dbForRoles({ boom: "throw" });
    const room = makeRoom([boom], db);

    const revoked = await room.revalidateAccess();
    expect(boom.closedWith).toBeNull();
    expect(revoked.size).toBe(0);
  });

  it("no connected sockets - no query, empty result", async () => {
    const { db, calls } = dbForRoles({});
    const room = makeRoom([], db);
    const revoked = await room.revalidateAccess();
    expect(calls.first).toBe(0);
    expect(revoked.size).toBe(0);
  });
});

// AUTH_DB stub for the session re-check: sessions[sid] is the joined row, or
// undefined (no row) / "throw".
function authDbFor(sessions: Record<string, Parameters<typeof sessionStillValid>[0] | "throw">) {
  return {
    prepare: () => ({
      bind: (sid: string) => ({
        first: async () => {
          const r = sessions[sid];
          if (r === "throw") throw new Error("auth db boom");
          return r ?? null;
        },
      }),
    }),
  } as unknown as D1Database;
}

const live = { expires_at: Date.now() + 60_000, revoked_at: null, moderation: 0, force_password_change: 0 };

describe("DocCollabRoom.revalidateAccess (session + account re-check)", () => {
  it("closes only the socket whose session was revoked; the user's other session stays", async () => {
    const stolen = fakeWs("alice", "s-old");
    const own = fakeWs("alice", "s-new");
    const { db } = dbForRoles({ alice: { project: "editor", org: null } });
    const room = makeRoom([stolen, own], db, authDbFor({
      "s-old": { ...live, revoked_at: Date.now() },
      "s-new": live,
    }));

    const revoked = await room.revalidateAccess();
    expect(stolen.closedWith?.code).toBe(1008);
    expect(own.closedWith).toBeNull();
    expect(revoked.has("sid:s-old")).toBe(true);
    expect(revoked.has("alice")).toBe(false);
  });

  it("closes sockets of a suspended account, an expired session, or a missing session row", async () => {
    const suspended = fakeWs("a", "s1");
    const expired = fakeWs("b", "s2");
    const missing = fakeWs("c", "s3");
    const { db } = dbForRoles({
      a: { project: "editor", org: null }, b: { project: "editor", org: null }, c: { project: "editor", org: null },
    });
    const room = makeRoom([suspended, expired, missing], db, authDbFor({
      s1: { ...live, moderation: Math.floor(Date.now() / 1000) + 3600 },
      s2: { ...live, expires_at: Date.now() - 1 },
    }));

    await room.revalidateAccess();
    expect(suspended.closedWith?.code).toBe(1008);
    expect(expired.closedWith?.code).toBe(1008);
    expect(missing.closedWith?.code).toBe(1008);
  });

  it("fails open on an AUTH_DB error and skips sockets without a sid", async () => {
    const errored = fakeWs("a", "s1");
    const legacy = fakeWs("b");
    const { db } = dbForRoles({ a: { project: "editor", org: null }, b: { project: "editor", org: null } });
    const room = makeRoom([errored, legacy], db, authDbFor({ s1: "throw" }));

    const revoked = await room.revalidateAccess();
    expect(errored.closedWith).toBeNull();
    expect(legacy.closedWith).toBeNull();
    expect(revoked.size).toBe(0);
  });
});

describe("sessionStillValid", () => {
  const now = Date.now();
  it("mirrors loadCurrentSession's gates", () => {
    expect(sessionStillValid(live, now)).toBe(true);
    expect(sessionStillValid(null, now)).toBe(false);
    expect(sessionStillValid({ ...live, force_password_change: 1 }, now)).toBe(false);
    expect(sessionStillValid({ ...live, moderation: -1 }, now)).toBe(false);
    // An elapsed suspension no longer blocks.
    expect(sessionStillValid({ ...live, moderation: Math.floor(now / 1000) - 10 }, now)).toBe(true);
  });
});
