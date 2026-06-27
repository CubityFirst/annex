import { describe, it, expect } from "vitest";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { awarenessUpdateIdentityOk } from "./DocCollabRoom";

// Hand-encodes an awareness update with arbitrary (clientId, state) entries,
// matching y-protocols' encodeAwarenessUpdate wire format. This is what a
// malicious client could put on the wire directly.
function encodeRaw(entries: Array<{ clientId: number; clock: number; state: unknown }>): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, entries.length);
  for (const e of entries) {
    encoding.writeVarUint(enc, e.clientId);
    encoding.writeVarUint(enc, e.clock);
    encoding.writeVarString(enc, JSON.stringify(e.state));
  }
  return encoding.toUint8Array(enc);
}

// Builds a real y-protocols awareness update for a single client whose local
// "user" state has the given id - exactly what WysiwygEditor.setLocalStateField
// produces - so the validator is tested against the genuine wire format.
function updateForUser(userId: string | null, clientId = 42): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = clientId;
  const awareness = new awarenessProtocol.Awareness(doc);
  if (userId === null) {
    awareness.setLocalState({ cursor: { anchor: 1, head: 2 } }); // no user field
  } else {
    awareness.setLocalStateField("user", { id: userId, name: "Someone", color: "#abc" });
  }
  return awarenessProtocol.encodeAwarenessUpdate(awareness, [clientId]);
}

describe("awarenessUpdateIdentityOk (presence-spoofing guard)", () => {
  it("accepts an update whose user.id matches the authenticated user", () => {
    expect(awarenessUpdateIdentityOk(updateForUser("user-1"), "user-1")).toBe(true);
  });

  it("rejects an update claiming a different user's id", () => {
    expect(awarenessUpdateIdentityOk(updateForUser("victim-2"), "attacker-1")).toBe(false);
  });

  it("allows cursor-only state with no user identity", () => {
    expect(awarenessUpdateIdentityOk(updateForUser(null), "user-1")).toBe(true);
  });

  it("rejects an update that injects a SECOND client's spoofed identity", () => {
    // Attacker's own (matching) entry plus an injected entry impersonating the
    // victim - the realistic spoof. Must be rejected as a whole.
    const update = encodeRaw([
      { clientId: 1, clock: 1, state: { user: { id: "attacker-1", name: "Me", color: "#1" } } },
      { clientId: 999, clock: 1, state: { user: { id: "victim-2", name: "Victim", color: "#2" } } },
    ]);
    expect(awarenessUpdateIdentityOk(update, "attacker-1")).toBe(false);
  });

  it("fails closed on a malformed payload", () => {
    expect(awarenessUpdateIdentityOk(new Uint8Array([0xff, 0xff, 0xff]), "user-1")).toBe(false);
  });
});
