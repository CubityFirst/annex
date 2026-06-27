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
