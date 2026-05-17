import { describe, it, expect, vi } from "vitest";
import { handleWebauthnAuthStart } from "./webauthn-auth-start";

// Minimal D1 mock: createAuthenticationOptions reads the user's credentials
// (.all → none) and inserts a challenge row (.run). No `users` lookup happens
// anymore — that existence check was the oracle this endpoint must not have.
function makeEnv() {
  const db = {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        first: vi.fn().mockResolvedValue(null),
      })),
    })),
  };
  return {
    DB: db,
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_RP_NAME: "Test",
    WEBAUTHN_ORIGIN: "http://localhost",
  } as unknown as Parameters<typeof handleWebauthnAuthStart>[1];
}

function req(body: unknown) {
  return new Request("http://localhost/webauthn/auth/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleWebauthnAuthStart — no account-existence oracle", () => {
  it("returns options (200) even for an unknown user, instead of 401", async () => {
    const res = await handleWebauthnAuthStart(req({ userId: "does-not-exist" }), makeEnv());
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; data: { options: unknown; challengeId: string } }>();
    expect(body.ok).toBe(true);
    expect(body.data.options).toBeDefined();
    expect(typeof body.data.challengeId).toBe("string");
  });

  it("still rejects a request with no userId", async () => {
    const res = await handleWebauthnAuthStart(req({}), makeEnv());
    expect(res.status).toBe(400);
  });
});
