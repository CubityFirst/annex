// Cloudflare's documented always-pass test secret. siteverify returns
// success:true for any token under this secret, so the network round-trip
// from local dev only adds latency and a flake surface - short-circuit it.
const ALWAYS_PASS_TEST_SECRET = "1x0000000000000000000000000000000AA";

export async function verifyTurnstile(token: string, secret: string): Promise<boolean> {
  if (secret === ALWAYS_PASS_TEST_SECRET) return true;

  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);

  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });

  const data = await res.json<{ success: boolean }>();
  return data.success;
}
