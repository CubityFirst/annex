import { describe, it, expect, vi } from "vitest";
import { handleRegister } from "./register";

function req(body: unknown) {
  return new Request("http://localhost/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeEnv(getBooleanValue?: ReturnType<typeof vi.fn>) {
  const prepare = vi.fn();
  return {
    env: {
      DB: { prepare },
      FLAGS: getBooleanValue ? { getBooleanValue } : undefined,
    } as unknown as Parameters<typeof handleRegister>[1],
    prepare,
  };
}

describe("handleRegister signup flag gate", () => {
  it("refuses with 403 and a message when the signup flag is off", async () => {
    const getBooleanValue = vi.fn().mockResolvedValue(false);
    const { env, prepare } = makeEnv(getBooleanValue);

    const res = await handleRegister(
      req({ email: "a@example.com", password: "correct horse battery staple", name: "A", turnstileToken: "t" }),
      env,
    );

    expect(res.status).toBe(403);
    const body = await res.json<{ ok: boolean; error: string }>();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("New sign-ups are currently disabled.");
    // The gate is checked before any parsing/DB work - nothing should be touched.
    expect(getBooleanValue).toHaveBeenCalledWith("signup", true);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("handleRegister email_verified", () => {
  it("stores email_verified = 0 even when the verification flag is off", async () => {
    // signup flag on, email-verification flag off.
    const getBooleanValue = vi.fn().mockImplementation((flag: string) =>
      Promise.resolve(flag === "signup"),
    );
    const calls: Array<{ sql: string; binds: unknown[] }> = [];
    const prepare = vi.fn((sql: string) => ({
      bind: (...binds: unknown[]) => {
        calls.push({ sql, binds });
        return {
          first: async () => null,
          run: async () => ({}),
        };
      },
    }));
    const env = {
      DB: { prepare },
      FLAGS: { getBooleanValue },
      TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
      JWT_SECRET: "test-secret",
    } as unknown as Parameters<typeof handleRegister>[1];

    const res = await handleRegister(
      req({ email: "a@example.com", password: "correct horse battery staple", name: "A", turnstileToken: "t" }),
      env,
    );

    expect(res.status).toBe(201);
    const body = await res.json<{ ok: boolean; data: { verificationSent: boolean } }>();
    expect(body.data.verificationSent).toBe(false);

    const insert = calls.find(c => c.sql.includes("INSERT INTO users"));
    expect(insert).toBeDefined();
    // The literal 0 lives in the SQL, not the binds - no bind may carry a 1
    // into the email_verified slot.
    expect(insert!.sql).toContain("email_verified) VALUES (?, ?, ?, ?, ?, 0)");
    expect(insert!.binds).toHaveLength(5);
  });
});
