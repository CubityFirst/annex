import { okResponse, errorResponse, Errors } from "../lib";
import { createAuthenticationOptions } from "../webauthn";
import type { Env } from "../index";

export async function handleWebauthnAuthStart(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ userId: string }>();
  if (!body.userId) return errorResponse(Errors.BAD_REQUEST);

  // Do NOT branch on whether the user exists. Returning UNAUTHORIZED for an
  // unknown userId (vs options for a known one) is an account-existence
  // oracle. For a non-existent / credential-less user createAuthenticationOptions
  // just yields empty allowCredentials; the ceremony then fails at /finish the
  // same way an invalid assertion does, so existence never leaks. This mirrors
  // how /login and /register avoid existence leaks. The endpoint is
  // IP-rate-limited (RATE_LIMITER_AUTH) so the extra challenge row is bounded.
  const { options, challengeId } = await createAuthenticationOptions(env, body.userId);

  return okResponse({ options, challengeId });
}
