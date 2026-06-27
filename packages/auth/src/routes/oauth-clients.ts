import { requireAuthenticatedSession } from "../auth-session";
import { errorResponse, Errors, okResponse, type Session } from "../lib";
import { bytesToB64url, hashClientSecret, parseRedirectUris } from "../oidc";
import type { Env } from "../index";

// Admin-only management of "Sign in with Annex" OIDC clients. These endpoints
// live on the auth worker (which owns auth-DB writes) and are reached only via
// the admin worker's AUTH service binding - they are NOT on the public
// auth.cubityfir.st routes (only /oauth/* and /.well-known/* are). Every
// handler still re-checks the admin session as defence in depth.

interface ClientRow {
  client_id: string;
  client_name: string;
  client_secret_hash: string | null;
  redirect_uris: string;
  allowed_scopes: string;
  trusted: number;
  disabled: number;
  created_at: number;
}

interface CreateBody {
  name?: string;
  redirect_uris?: string[];
  scopes?: string;
  trusted?: boolean;
  public?: boolean;
}

interface ClientIdBody {
  client_id?: string;
}

interface SetDisabledBody {
  client_id?: string;
  disabled?: boolean;
}

const ALLOWED_SCOPES = ["openid", "profile", "email", "roles"];

async function requireAdmin(request: Request, env: Env): Promise<Session | Response> {
  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;
  if (!session.isAdmin) return errorResponse(Errors.FORBIDDEN);
  return session;
}

function isValidRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    // https everywhere; localhost is allowed for development callbacks.
    return u.protocol === "https:" || u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

// Restrict to the known scopes and guarantee `openid`. Empty/missing => the
// full default set. Returns null for an unknown scope (caller rejects).
function normalizeScopes(input: string | undefined): string | null {
  if (input === undefined || input.trim() === "") return "openid profile email";
  const set = new Set(input.split(/\s+/).filter(Boolean));
  for (const s of set) if (!ALLOWED_SCOPES.includes(s)) return null;
  if (!set.has("openid")) return null;
  return ALLOWED_SCOPES.filter((s) => set.has(s)).join(" ");
}

function randomHex(bytes: number): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateSecret(): string {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
}

// Never expose the secret hash. Secrets are returned exactly once, at creation
// or rotation, and never stored in plaintext.
function publicView(row: ClientRow) {
  return {
    client_id: row.client_id,
    client_name: row.client_name,
    is_public: row.client_secret_hash === null,
    redirect_uris: parseRedirectUris(row.redirect_uris),
    allowed_scopes: row.allowed_scopes,
    trusted: Boolean(row.trusted),
    disabled: Boolean(row.disabled),
    created_at: row.created_at,
  };
}

// GET /admin/oauth/clients
export async function handleOAuthClientsList(request: Request, env: Env): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (session instanceof Response) return session;

  const rows = await env.DB.prepare(
    `SELECT client_id, client_name, client_secret_hash, redirect_uris, allowed_scopes, trusted, disabled, created_at
     FROM oauth_clients ORDER BY created_at DESC`,
  ).all<ClientRow>();

  return okResponse({ clients: rows.results.map(publicView) });
}

// POST /admin/oauth/clients  { name, redirect_uris[], scopes?, trusted?, public? }
export async function handleOAuthClientCreate(request: Request, env: Env): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (session instanceof Response) return session;

  const body = await request.json<CreateBody>().catch(() => ({} as CreateBody));

  const name = (body.name ?? "").trim();
  const redirects = Array.isArray(body.redirect_uris)
    ? [...new Set(body.redirect_uris.map((s) => s.trim()).filter(Boolean))]
    : [];

  if (!name || redirects.length === 0) return errorResponse(Errors.BAD_REQUEST);
  if (!redirects.every(isValidRedirect)) {
    return Response.json({ ok: false, error: "invalid_redirect_uri" }, { status: 400 });
  }

  const scopes = normalizeScopes(body.scopes);
  if (!scopes) return Response.json({ ok: false, error: "invalid_scope" }, { status: 400 });

  const isPublic = body.public === true;
  const trusted = body.trusted === false ? 0 : 1;
  const clientId = `annx_${randomHex(12)}`;

  let secret: string | null = null;
  let secretHash: string | null = null;
  if (!isPublic) {
    secret = generateSecret();
    secretHash = await hashClientSecret(secret);
  }

  await env.DB.prepare(
    `INSERT INTO oauth_clients (client_id, client_name, client_secret_hash, redirect_uris, allowed_scopes, trusted, disabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  ).bind(clientId, name, secretHash, JSON.stringify(redirects), scopes, trusted, Date.now()).run();

  // `client_secret` is returned ONCE here and never again.
  return okResponse({
    client_id: clientId,
    client_secret: secret,
    client_name: name,
    is_public: isPublic,
    redirect_uris: redirects,
    allowed_scopes: scopes,
    trusted: Boolean(trusted),
    disabled: false,
  });
}

// POST /admin/oauth/clients/set-disabled  { client_id, disabled }
export async function handleOAuthClientSetDisabled(request: Request, env: Env): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (session instanceof Response) return session;

  const body = await request.json<SetDisabledBody>().catch(() => ({} as SetDisabledBody));
  if (!body.client_id || typeof body.disabled !== "boolean") return errorResponse(Errors.BAD_REQUEST);

  const result = await env.DB.prepare(
    "UPDATE oauth_clients SET disabled = ? WHERE client_id = ?",
  ).bind(body.disabled ? 1 : 0, body.client_id).run();

  if ((result.meta.changes ?? 0) === 0) return errorResponse(Errors.NOT_FOUND);
  return okResponse({ client_id: body.client_id, disabled: body.disabled });
}

// POST /admin/oauth/clients/delete  { client_id }
export async function handleOAuthClientDelete(request: Request, env: Env): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (session instanceof Response) return session;

  const body = await request.json<ClientIdBody>().catch(() => ({} as ClientIdBody));
  if (!body.client_id) return errorResponse(Errors.BAD_REQUEST);

  // ON DELETE CASCADE drops any outstanding oauth_codes for this client.
  const result = await env.DB.prepare(
    "DELETE FROM oauth_clients WHERE client_id = ?",
  ).bind(body.client_id).run();

  if ((result.meta.changes ?? 0) === 0) return errorResponse(Errors.NOT_FOUND);
  return okResponse({ client_id: body.client_id, deleted: true });
}

// POST /admin/oauth/clients/rotate-secret  { client_id }
export async function handleOAuthClientRotateSecret(request: Request, env: Env): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (session instanceof Response) return session;

  const body = await request.json<ClientIdBody>().catch(() => ({} as ClientIdBody));
  if (!body.client_id) return errorResponse(Errors.BAD_REQUEST);

  const existing = await env.DB.prepare(
    "SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?",
  ).bind(body.client_id).first<{ client_secret_hash: string | null }>();
  if (!existing) return errorResponse(Errors.NOT_FOUND);
  if (existing.client_secret_hash === null) {
    // Public clients have no secret to rotate.
    return Response.json({ ok: false, error: "public_client_no_secret" }, { status: 400 });
  }

  const secret = generateSecret();
  await env.DB.prepare(
    "UPDATE oauth_clients SET client_secret_hash = ? WHERE client_id = ?",
  ).bind(await hashClientSecret(secret), body.client_id).run();

  return okResponse({ client_id: body.client_id, client_secret: secret });
}
