import { okResponse } from "../lib";
import { createDiscoverableAuthenticationOptions } from "../webauthn";
import type { Env } from "../index";

// Starts a usernameless passkey sign-in. No identity in, so nothing to leak:
// the browser offers whichever passkeys it holds for this RP ID. IP-rate-limited
// in index.ts (RATE_LIMITER_AUTH), which bounds the challenge rows it writes.
export async function handlePasskeyAuthStart(_request: Request, env: Env): Promise<Response> {
  const { options, challengeId } = await createDiscoverableAuthenticationOptions(env);
  return okResponse({ options, challengeId });
}
