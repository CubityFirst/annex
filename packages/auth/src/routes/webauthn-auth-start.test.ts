import { describe, it, expect, vi } from "vitest";
import { handleWebauthnAuthStart } from "./webauthn-auth-start";

// Minimal D1 mock: createAuthenticationOptions reads the user's credentials
// (.all → `creds`) and inserts a challenge row (.run). No `users` lookup happens
// anymore - that existence check was the oracle this endpoint must not have.
function makeEnv(creds: Array<{ id: string; transports: string | null }> = []) {
  const db = {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        all: vi.fn().mockResolvedValue({ results: creds }),
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

describe("handleWebauthnAuthStart - no account-existence oracle", () => {
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

describe("handleWebauthnAuthStart - transports hint in allowCredentials", () => {
  async function allowCredentials(creds: Array<{ id: string; transports: string | null }>) {
    const res = await handleWebauthnAuthStart(req({ userId: "u1" }), makeEnv(creds));
    const body = await res.json<{
      data: { options: { allowCredentials?: Array<{ transports?: string[] }> } };
    }>();
    return body.data.options.allowCredentials ?? [];
  }

  it("echoes the stored transports back", async () => {
    const list = await allowCredentials([{ id: "AQIDBA", transports: '["internal","hybrid"]' }]);
    expect(list).toHaveLength(1);
    expect(list[0].transports).toEqual(["internal", "hybrid"]);
  });

  it("falls back to internal+hybrid when transports are NULL (legacy credential)", async () => {
    const list = await allowCredentials([{ id: "AQIDBA", transports: null }]);
    expect(list[0].transports).toEqual(["internal", "hybrid"]);
  });

  it("falls back to the default when transports JSON is malformed", async () => {
    const list = await allowCredentials([{ id: "AQIDBA", transports: "not json" }]);
    expect(list[0].transports).toEqual(["internal", "hybrid"]);
  });
});
