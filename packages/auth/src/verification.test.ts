import { describe, it, expect, vi } from "vitest";
import { isEmailVerificationEnabled } from "./verification";

function makeEnv(opts: { appOrigin?: string; devVar?: string; flagValue?: boolean }) {
  const getBooleanValue = vi.fn().mockResolvedValue(opts.flagValue ?? false);
  const env = {
    APP_ORIGIN: opts.appOrigin,
    DEV_EMAIL_VERIFICATION: opts.devVar,
    FLAGS: opts.flagValue === undefined ? undefined : { getBooleanValue },
  } as unknown as Parameters<typeof isEmailVerificationEnabled>[0];
  return { env, getBooleanValue };
}

describe("isEmailVerificationEnabled", () => {
  it("bypasses (returns false) on a localhost deployment even when the flag is on", async () => {
    const { env, getBooleanValue } = makeEnv({ appOrigin: "http://localhost:5173", flagValue: true });
    expect(await isEmailVerificationEnabled(env, "u1")).toBe(false);
    // The flag isn't even consulted - dashboard flips can't gate local dev.
    expect(getBooleanValue).not.toHaveBeenCalled();
  });

  it("bypasses on a 127.0.0.1 deployment too", async () => {
    const { env } = makeEnv({ appOrigin: "http://127.0.0.1:5173", flagValue: true });
    expect(await isEmailVerificationEnabled(env, "u1")).toBe(false);
  });

  it("DEV_EMAIL_VERIFICATION=true opts a localhost deployment back into the flag", async () => {
    const { env, getBooleanValue } = makeEnv({ appOrigin: "http://localhost:5173", devVar: "true", flagValue: true });
    expect(await isEmailVerificationEnabled(env, "u1")).toBe(true);
    expect(getBooleanValue).toHaveBeenCalledWith("email-verification", false, { userId: "u1" });
  });

  it("reads the flag on a production origin", async () => {
    const on = makeEnv({ appOrigin: "https://docs.cubityfir.st", flagValue: true });
    expect(await isEmailVerificationEnabled(on.env, "u1")).toBe(true);

    const off = makeEnv({ appOrigin: "https://docs.cubityfir.st", flagValue: false });
    expect(await isEmailVerificationEnabled(off.env, "u1")).toBe(false);
  });

  it("returns false when the FLAGS binding is absent", async () => {
    const { env } = makeEnv({ appOrigin: "https://docs.cubityfir.st" });
    expect(await isEmailVerificationEnabled(env, "u1")).toBe(false);
  });

  it("does not treat an unset APP_ORIGIN as local (unit-test envs read the flag)", async () => {
    const { env, getBooleanValue } = makeEnv({ flagValue: true });
    expect(await isEmailVerificationEnabled(env, "u1")).toBe(true);
    expect(getBooleanValue).toHaveBeenCalled();
  });
});
