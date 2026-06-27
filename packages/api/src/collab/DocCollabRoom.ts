import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { Env } from "../index";
import { ROLE_RANK } from "../lib";
import { resolveAccess } from "../lib/access";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

// Per-WS-frame ceiling. Legitimate Yjs traffic is small (steady-state edits + awareness are
// well under 1 KB); the only large message is the initial sync of full state from a connecting
// client, which for a markdown doc stays comfortably below this. CF's WS frame cap is ~1 MB,
// so this turns "frame dropped" into "socket closed with reason".
const MAX_MESSAGE_BYTES = 512 * 1024;

// Total Y.Doc state ceiling, measured by Y.encodeStateAsUpdate(...).byteLength. ~40× the
// largest realistic markdown doc + edit history. Crossing this freezes the room so persist()
// is a no-op - on next DO load we restore the pre-bloat snapshot from R2.
const MAX_DOC_STATE_BYTES = 2 * 1024 * 1024;

// Y.encodeStateAsUpdate is O(state size) so we only run the full check when accumulated
// delta since the last check exceeds this. Updates are append-merged, so summed delta is
// an upper bound on growth between checks.
const DELTA_RECHECK_BYTES = 64 * 1024;

// A collab socket is authorized exactly ONCE, at WebSocket upgrade
// (handleCollabUpgrade in index.ts). Every other surface resolves access at read
// time, but nothing tears down a live socket, so a user who loses editor access
// mid-session (direct member removal/demotion, org-member removal, whole-org
// delete) would keep editing until they disconnect. We re-resolve effective
// access for every connected socket, piggybacked on incoming room traffic (no
// timer - WS hibernation is preserved) and throttled to at most once per room
// per this interval, closing any socket that no longer has editor+ (1008). This
// bounds the leak window for an actively-trafficked room to ~this long.
//
// Writes are always cut: a revoked sender's own in-flight frame is dropped (see
// webSocketMessage). The only residual is a revoked user who goes fully idle -
// they keep a read view of FUTURE broadcast edits until ANY participant sends a
// frame, which re-arms this sweep and closes them; a fully idle room broadcasts
// nothing, so there is nothing to leak.
//
// We deliberately do NOT fan a close out from the membership routes: that would
// instantiate one DO per doc across the whole site (or whole org), on every
// membership change - CF subrequest limits + latency - whereas this only ever
// runs in rooms that already hold a live socket.
const AUTH_RECHECK_MS = 15_000;

interface WsAttachment {
  userId: string;
  userName: string;
  clientId: number | null;
}

// Validates that every client state embedded in an awareness update claims the
// connection's authenticated user id. A malicious editor can otherwise inject
// awareness entries carrying another member's identity, spoofing their presence
// avatar / cursor label to everyone else in the room. Returns false on any
// mismatch or malformed payload so the caller drops the update (fail-closed).
// Cursor-only / removal (null) states carry no identity and are allowed.
//
// Wire format mirrors y-protocols `encodeAwarenessUpdate`:
//   varUint count, then per client: varUint clientID, varUint clock,
//   varString JSON.stringify(state).
export function awarenessUpdateIdentityOk(updateBytes: Uint8Array, expectedUserId: string): boolean {
  try {
    const d = decoding.createDecoder(updateBytes);
    const numClients = decoding.readVarUint(d);
    for (let i = 0; i < numClients; i++) {
      decoding.readVarUint(d); // clientID
      decoding.readVarUint(d); // clock
      const stateStr = decoding.readVarString(d);
      if (stateStr === "null") continue; // removal - no identity claimed
      const state = JSON.parse(stateStr) as { user?: { id?: unknown } } | null;
      if (state && state.user && "id" in state.user && state.user.id !== expectedUserId) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function toUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  // wrangler dev can deserialize stored Uint8Arrays as plain objects
  if (value && typeof value === "object") {
    try { return new Uint8Array(Object.values(value as Record<string, number>)); } catch { /* */ }
  }
  return null;
}

export class DocCollabRoom implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;

  private ydoc: Y.Doc | null = null;
  private awareness: awarenessProtocol.Awareness | null = null;
  private editors: Map<string, string> | null = null; // userId → userName
  private lastAlarmSetAt = 0;
  private frozen = false;
  private pendingDeltaBytes = 0;
  // True once the room has a known content baseline - either a snapshot was
  // restored from storage or a client synced content in. Until then the
  // Y.Doc is empty only because nothing has loaded yet, so persist() must
  // NOT write that emptiness over the real content in R2. Once true, an
  // empty doc is a genuine delete-all and MUST be persisted.
  private contentLoaded = false;
  // Site id for this room's doc, cached from the connect-time docKey so the
  // access re-check doesn't re-read storage every sweep.
  private projectId: string | null = null;
  // Wall-clock of the last access-revalidation sweep; throttles revalidateAccess.
  private lastAuthSweepAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.ydoc) return;

    const ydoc = new Y.Doc();
    this.ydoc = ydoc;
    try {
      const raw = await this.ctx.storage.get<unknown>("ydoc");
      const stored = toUint8Array(raw);
      if (stored) {
        Y.applyUpdate(ydoc, stored);
        // We have a real baseline from storage - applyUpdate ran before the
        // "update" handler below was attached, so set the flag explicitly.
        this.contentLoaded = true;
        if (stored.byteLength > MAX_DOC_STATE_BYTES) {
          // Persisted snapshot is already over the cap. Freeze immediately so persist() is a
          // no-op - refusing to write the bloat back to R2 is the only useful response here.
          console.error(`[DocCollabRoom] stored state ${stored.byteLength}B exceeds cap ${MAX_DOC_STATE_BYTES}B; freezing room`);
          this.frozen = true;
        }
      }
    } catch (err) {
      console.error("[DocCollabRoom] failed to restore ydoc from storage:", err);
    }

    this.editors = new Map();
    try {
      const stored = await this.ctx.storage.get<{ id: string; name: string }[]>("editors");
      if (stored) {
        for (const e of stored) this.editors.set(e.id, e.name);
      }
    } catch { /* */ }

    const awareness = new awarenessProtocol.Awareness(ydoc);
    // The Awareness constructor starts a 3s setInterval to expire stale clients. That timer
    // prevents WebSocket hibernation, so the DO accrues memory × wall-time billing the entire
    // session. Kill it - webSocketClose already removes awareness state on disconnect.
    clearInterval((awareness as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval);
    this.awareness = awareness;

    ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      // A client synced content in (seed or edit, including a delete-all).
      // The room now has a real baseline that persist() must reflect.
      this.contentLoaded = true;
      this.pendingDeltaBytes += update.byteLength;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const msg = encoding.toUint8Array(encoder);
      for (const ws of this.ctx.getWebSockets()) {
        if (ws !== origin) {
          try { ws.send(msg); } catch { /* socket may be closing */ }
        }
      }
    });

    // Use the captured `awareness` reference - not `this.awareness` - so that if the room is
    // torn down and re-initialised, the old interval callbacks still reference the correct
    // (now-destroyed) instance and don't accidentally encode clients against a fresh meta map.
    awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changedClients = [...added, ...updated, ...removed];
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients));
      const msg = encoding.toUint8Array(encoder);
      for (const ws of this.ctx.getWebSockets()) {
        if (ws !== origin) {
          try { ws.send(msg); } catch { /* socket may be closing */ }
        }
      }
    });
  }

  private teardown(): void {
    // Destroy awareness first so its setInterval is cleared and no stale update events fire
    // after this room is re-initialised with a new Y.Doc / Awareness pair.
    if (this.awareness) {
      try { this.awareness.destroy(); } catch { /* */ }
      this.awareness = null;
    }
    if (this.ydoc) {
      try { this.ydoc.destroy(); } catch { /* */ }
      this.ydoc = null;
    }
    this.editors = null;
    this.frozen = false;
    this.pendingDeltaBytes = 0;
    this.contentLoaded = false;
  }

  async fetch(request: Request): Promise<Response> {
    // WebSocket upgrade must be checked first - upgrade requests are GET requests too,
    // so checking method before Upgrade header would intercept them with the wrong branch.
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request);
    }

    // Internal - returns and clears the set of users who have contributed edits
    if (request.method === "GET") {
      const stored = await this.ctx.storage.get<{ id: string; name: string }[]>("editors") ?? [];
      await this.ctx.storage.delete("editors");
      if (this.editors) this.editors.clear();
      return new Response(JSON.stringify({ editors: stored }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Internal cleanup - called when the document is deleted
    if (request.method === "DELETE") {
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.close(1001, "Document deleted"); } catch { /* */ }
      }
      try { await this.ctx.storage.deleteAll(); } catch { /* */ }
      this.teardown();
      return new Response(null, { status: 204 });
    }

    return new Response("Method not allowed", { status: 405 });
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const userId = request.headers.get("X-User-Id") ?? "";
    const userName = request.headers.get("X-User-Name") ?? "";
    const projectId = request.headers.get("X-Project-Id") ?? "";
    const docId = request.headers.get("X-Doc-Id") ?? "";
    if (projectId) this.projectId = projectId;

    try {
      const existingKey = await this.ctx.storage.get<string>("docKey");
      if (!existingKey && projectId && docId) {
        await this.ctx.storage.put("docKey", `${projectId}/${docId}`);
      }
    } catch (err) {
      console.error("[DocCollabRoom] storage error in fetch:", err);
    }

    await this.ensureLoaded();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId, userName, clientId: null } satisfies WsAttachment);

    // If the room is frozen on load (persisted state already exceeds the cap), close the
    // socket immediately. Sending sync step1 first would just be wasted bytes, and waiting
    // for the client's first message to close means a slightly worse "open then close" UX.
    if (this.frozen) {
      try { server.close(1008, "doc size limit exceeded"); } catch { /* */ }
      return new Response(null, { status: 101, webSocket: client });
    }

    try {
      const syncEncoder = encoding.createEncoder();
      encoding.writeVarUint(syncEncoder, MSG_SYNC);
      syncProtocol.writeSyncStep1(syncEncoder, this.ydoc!);
      server.send(encoding.toUint8Array(syncEncoder));

      const awarenessStates = this.awareness!.getStates();
      if (awarenessStates.size > 0) {
        const awarenessEncoder = encoding.createEncoder();
        encoding.writeVarUint(awarenessEncoder, MSG_AWARENESS);
        encoding.writeVarUint8Array(awarenessEncoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness!, Array.from(awarenessStates.keys())));
        server.send(encoding.toUint8Array(awarenessEncoder));
      }
    } catch (err) {
      console.error("[DocCollabRoom] error sending initial sync state:", err);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // Re-resolve effective access for every currently-connected socket and close
  // any whose user no longer has editor+ on the site (membership removed,
  // demoted below editor, org membership revoked, or org deleted). Throttled to
  // once per AUTH_RECHECK_MS and driven by incoming traffic, so it adds no timer
  // and only runs for rooms with live sockets. Returns the set of userIds closed
  // this sweep so the caller can drop the in-flight frame of a now-revoked sender.
  private async revalidateAccess(): Promise<Set<string>> {
    const revoked = new Set<string>();
    const now = Date.now();
    if (now - this.lastAuthSweepAt < AUTH_RECHECK_MS) return revoked;
    this.lastAuthSweepAt = now;

    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return revoked;

    let projectId = this.projectId;
    if (!projectId) {
      const docKey = await this.ctx.storage.get<string>("docKey");
      projectId = docKey ? docKey.split("/")[0] : null;
      this.projectId = projectId;
    }
    if (!projectId) return revoked; // can't resolve without it - fail open (no worse than before)
    const pid = projectId;

    // Resolve every DISTINCT connected user once, in parallel - one indexed read
    // each. editor+ keeps the socket; anything lower (or null = no membership)
    // gets closed. A transient resolver/DB error fails OPEN for that user: we
    // don't tear down a live session over a blip (reconnect re-checks at upgrade).
    const uids = new Set<string>();
    for (const ws of sockets) {
      const uid = (ws.deserializeAttachment() as WsAttachment | null)?.userId;
      if (uid) uids.add(uid);
    }
    if (uids.size === 0) return revoked;
    const allowedById = new Map<string, boolean>();
    await Promise.all([...uids].map(async (uid) => {
      try {
        const access = await resolveAccess(this.env.DB, pid, uid);
        allowedById.set(uid, access !== null && ROLE_RANK[access.role] >= ROLE_RANK["editor"]);
      } catch {
        allowedById.set(uid, true);
      }
    }));

    // Close every socket whose user lost access. Clean up the closed socket's Yjs
    // awareness explicitly (and broadcast the removal): a server-initiated
    // ws.close() does NOT reliably invoke webSocketClose under this worker's compat
    // date, and the awareness expiry timer is disabled (see ensureLoaded), so
    // without this the revoked user's cursor/avatar would linger for everyone else.
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as WsAttachment | null;
      const uid = att?.userId;
      if (!att || !uid) continue;
      if (allowedById.get(uid) === false) {
        revoked.add(uid);
        if (this.awareness && att.clientId != null) {
          try { awarenessProtocol.removeAwarenessStates(this.awareness, [att.clientId], ws); } catch { /* */ }
        }
        try { ws.close(1008, "access revoked"); } catch { /* */ }
      }
    }
    return revoked;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Reject oversized frames before doing any work. String length undercounts UTF-8 bytes
    // but Yjs traffic is binary; a string this long is itself anomalous.
    const messageSize = typeof message === "string" ? message.length : message.byteLength;
    if (messageSize > MAX_MESSAGE_BYTES) {
      try { ws.close(1009, "message too large"); } catch { /* */ }
      return;
    }

    try {
      await this.ensureLoaded();

      if (this.frozen) {
        try { ws.close(1008, "doc size limit exceeded"); } catch { /* */ }
        return;
      }

      // Re-authorize the room (throttled). If THIS sender just lost access, drop
      // their in-flight frame so a revoked editor's last message can't still
      // mutate the doc after their socket is closed.
      const revoked = await this.revalidateAccess();
      if (revoked.size > 0) {
        const self = ws.deserializeAttachment() as WsAttachment | null;
        if (self?.userId && revoked.has(self.userId)) return;
      }

      const data = typeof message === "string"
        ? new TextEncoder().encode(message)
        : new Uint8Array(message);

      const decoder = decoding.createDecoder(data);
      const messageType = decoding.readVarUint(decoder);

      switch (messageType) {
        case MSG_SYNC: {
          const replyEncoder = encoding.createEncoder();
          encoding.writeVarUint(replyEncoder, MSG_SYNC);
          let syncType: number;
          try {
            syncType = syncProtocol.readSyncMessage(decoder, replyEncoder, this.ydoc!, ws);
          } catch (err) {
            console.error("[DocCollabRoom] sync protocol error:", err);
            break;
          }
          if (encoding.length(replyEncoder) > 1) {
            try { ws.send(encoding.toUint8Array(replyEncoder)); } catch { /* */ }
          }
          if (syncType === 2) {
            // Update was applied to ydoc. If we've absorbed enough delta since the last
            // check, run the (expensive) full state size check and freeze if over cap.
            if (this.pendingDeltaBytes > DELTA_RECHECK_BYTES) {
              this.pendingDeltaBytes = 0;
              const stateSize = Y.encodeStateAsUpdate(this.ydoc!).byteLength;
              if (stateSize > MAX_DOC_STATE_BYTES) {
                console.error(`[DocCollabRoom] Y.Doc state ${stateSize}B exceeds cap ${MAX_DOC_STATE_BYTES}B; freezing room`);
                this.frozen = true;
                for (const sock of this.ctx.getWebSockets()) {
                  try { sock.close(1008, "doc size limit exceeded"); } catch { /* */ }
                }
                return;
              }
            }

            // Throttle alarm rewrites to once every 5s. Each setAlarm is a storage write,
            // and the previous code rewrote the alarm on every keystroke. The alarm still
            // fires ~30s after the last edit (between 30s and 35s, depending on which
            // 5s bucket the last edit landed in), so persistence behavior is unchanged.
            const now = Date.now();
            if (now - this.lastAlarmSetAt > 5000) {
              this.lastAlarmSetAt = now;
              this.ctx.storage.setAlarm(now + 30_000).catch(() => { /* */ });
            }
            // Track this user as a contributor
            const att = ws.deserializeAttachment() as WsAttachment | null;
            if (att?.userId && this.editors && !this.editors.has(att.userId)) {
              this.editors.set(att.userId, att.userName);
              const list = Array.from(this.editors.entries()).map(([id, name]) => ({ id, name }));
              this.ctx.storage.put("editors", list).catch(() => { /* */ });
            }
          }
          break;
        }
        case MSG_AWARENESS: {
          const updateBytes = decoding.readVarUint8Array(decoder);

          const attachment = ws.deserializeAttachment() as WsAttachment | null;

          // Drop awareness updates that claim any identity other than this
          // connection's authenticated user - prevents presence/cursor
          // impersonation of another member. (Durable edit attribution already
          // uses att.userId, not the client-supplied awareness state.)
          if (attachment?.userId && !awarenessUpdateIdentityOk(updateBytes, attachment.userId)) {
            break;
          }

          if (attachment?.clientId === null) {
            try {
              const d = decoding.createDecoder(updateBytes);
              const numClients = decoding.readVarUint(d);
              if (numClients > 0) {
                const clientId = decoding.readVarUint(d);
                ws.serializeAttachment({ ...attachment, clientId });
              }
            } catch { /* best-effort */ }
          }

          try {
            awarenessProtocol.applyAwarenessUpdate(this.awareness!, updateBytes, ws);
          } catch (err) {
            console.error("[DocCollabRoom] awareness update error:", err);
          }
          break;
        }
      }
    } catch (err) {
      console.error("[DocCollabRoom] webSocketMessage error:", err);
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    try {
      await this.ensureLoaded();

      const attachment = ws.deserializeAttachment() as WsAttachment | null;
      if (attachment?.clientId != null) {
        try {
          awarenessProtocol.removeAwarenessStates(this.awareness!, [attachment.clientId], ws);
        } catch { /* */ }
      }

      if (this.ctx.getWebSockets().length === 0) {
        await this.persist();
        // Schedule eviction 7 days from now; a reconnect will cancel this via the next edit alarm
        this.ctx.storage.setAlarm(Date.now() + 7 * 24 * 60 * 60 * 1000).catch(() => { /* */ });
        // Drop in-memory ydoc/awareness so the DO can be evicted instead of sitting idle
        this.teardown();
      }
    } catch (err) {
      console.error("[DocCollabRoom] webSocketClose error:", err);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("[DocCollabRoom] webSocketError:", error);
    try { ws.close(1011, "Internal error"); } catch { /* */ }
  }

  async alarm(): Promise<void> {
    try {
      // `lastActivity` is only ever written by persist(). If it is unset, the
      // room has edits from a session that never persisted (e.g. persist-on-
      // close didn't run) - defaulting to 0 would make `now - 0 >= 7d` true
      // and evict (deleteAll) those unsaved edits, reverting the doc to its
      // stale R2 body. Default to "now" so an unpersisted room persists here
      // instead of being wiped; only a genuinely 7-day-idle (already
      // persisted) room is evicted.
      const lastActivity = await this.ctx.storage.get<number>("lastActivity") ?? Date.now();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (Date.now() - lastActivity >= sevenDays) {
        // No activity for 7 days - evict the room entirely
        await this.ctx.storage.deleteAll();
        this.teardown();
      } else {
        await this.persist();
      }
    } catch (err) {
      console.error("[DocCollabRoom] alarm error:", err);
    }
  }

  private async persist(): Promise<void> {
    if (!this.ydoc) return;
    // Refuse to write bloated state back to R2. The previously-good snapshot already in
    // storage is what we want a future load to restore from.
    if (this.frozen) return;
    // No baseline yet - the doc is empty only because nothing has loaded.
    // Persisting now would clobber the real content in R2/storage with "".
    if (!this.contentLoaded) return;

    const bytes = Y.encodeStateAsUpdate(this.ydoc);
    await this.ctx.storage.put("ydoc", bytes);
    await this.ctx.storage.put("lastActivity", Date.now());

    // Mirror current state to R2 unconditionally - including empty content.
    // A collaborative delete-all produces an empty doc that MUST overwrite
    // the old R2 body, otherwise the deletion silently reverts once the DO
    // is evicted and a future load re-seeds from the stale R2 object.
    const text = this.ydoc.getText("content").toString();
    const docKey = await this.ctx.storage.get<string>("docKey");
    if (docKey) {
      await this.env.ASSETS.put(docKey, text);
    }
  }
}
