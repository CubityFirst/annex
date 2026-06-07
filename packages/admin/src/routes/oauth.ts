import { Hono } from "hono";
import type { Context } from "hono";
import { writeAdminAudit } from "../audit";
import type { AppEnv } from "../index";

// OIDC client management for the admin dashboard. The admin worker is a thin
// authenticated proxy here — the oauth_clients table lives in the auth DB,
// which the admin worker binds read-only by convention, so every read and
// write is forwarded to the auth worker (which owns auth-DB writes and the
// client-secret hashing). `enforceAdmin` has already validated the session;
// the auth worker re-checks it as defence in depth.

const oauthRouter = new Hono<AppEnv>();

// List — read-only, no audit. Forwarded verbatim.
oauthRouter.get("/", (c) => {
  const auth = c.req.raw.headers.get("Authorization");
  return c.env.AUTH.fetch("https://auth/admin/oauth/clients", {
    method: "GET",
    headers: auth ? { Authorization: auth } : {},
  });
});

// Forward a POST mutation to the auth worker, then — only if it succeeded —
// write an actor-attributed admin_audit_log row, mirroring the other admin
// mutation routes. `clientIdFrom` says where the affected client_id lives:
// the success response (create mints a new id) or the request (the rest).
//
// detailKeys is an explicit ALLOWLIST of fields copied into the audit detail —
// it must never include `client_secret`, which the create/rotate responses
// carry (shown once to the operator, never logged).
async function forwardMutation(
  c: Context<AppEnv>,
  authPath: string,
  action: string,
  opts: {
    clientIdFrom: "request" | "response";
    detailFrom?: "request" | "response";
    detailKeys?: string[];
  },
): Promise<Response> {
  const auth = c.req.raw.headers.get("Authorization");
  const bodyText = await c.req.raw.text();

  const res = await c.env.AUTH.fetch(`https://auth${authPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: bodyText,
  });

  // Read the body so we can both inspect it for auditing and return it.
  const resText = await res.text();
  let responseJson: { ok?: boolean; data?: Record<string, unknown> } = {};
  try {
    responseJson = JSON.parse(resText);
  } catch {
    /* non-JSON response — treat as failure, skip audit */
  }
  let requestJson: Record<string, unknown> = {};
  try {
    requestJson = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    /* no/invalid body */
  }

  if (responseJson.ok === true) {
    const idSource = opts.clientIdFrom === "response" ? responseJson.data : requestJson;
    const clientId = (idSource?.client_id as string | undefined) ?? null;

    let detail: Record<string, unknown> | undefined;
    if (opts.detailFrom && opts.detailKeys?.length) {
      const src = (opts.detailFrom === "response" ? responseJson.data : requestJson) ?? {};
      detail = {};
      for (const k of opts.detailKeys) if (k in src) detail[k] = src[k];
    }
    await writeAdminAudit(c.env, c.get("session"), action, "oauth_client", clientId, detail);
  }

  // Reconstruct the response (the body stream was consumed above).
  return new Response(resText, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}

oauthRouter.post("/", (c) =>
  forwardMutation(c, "/admin/oauth/clients", "oauth_client.create", {
    clientIdFrom: "response",
    detailFrom: "response",
    detailKeys: ["client_name", "is_public", "trusted"], // never client_secret
  }),
);
oauthRouter.post("/set-disabled", (c) =>
  forwardMutation(c, "/admin/oauth/clients/set-disabled", "oauth_client.set_disabled", {
    clientIdFrom: "request",
    detailFrom: "request",
    detailKeys: ["disabled"],
  }),
);
oauthRouter.post("/delete", (c) =>
  forwardMutation(c, "/admin/oauth/clients/delete", "oauth_client.delete", { clientIdFrom: "request" }),
);
oauthRouter.post("/rotate-secret", (c) =>
  forwardMutation(c, "/admin/oauth/clients/rotate-secret", "oauth_client.rotate_secret", { clientIdFrom: "request" }),
);

export { oauthRouter };
