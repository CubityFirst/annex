import { okResponse, errorResponse, Errors, ROLE_RANK, ProjectFeatures, type Session } from "../lib";
import { resolveRole } from "../lib/access";
import {
  cfCreateCustomHostname,
  cfGetCustomHostname,
  cfDeleteCustomHostname,
  customDomainsConfigured,
  deriveDnsRecords,
  deriveStatus,
  collectVerificationErrors,
  isValidHostname,
  isReservedHostname,
  normalizeHostname,
  CustomDomainError,
  type CfCustomHostname,
  type DnsRecord,
} from "../lib/customDomains";
import type { Env } from "../index";

interface DomainRow {
  project_id: string;
  hostname: string;
  cf_hostname_id: string | null;
  status: string;
  hostname_status: string | null;
  ssl_status: string | null;
  dns_records: string | null;
  verification_errors: string | null;
  created_at: string;
  updated_at: string;
}

function rowToApi(row: DomainRow, cnameTarget: string) {
  let dnsRecords: DnsRecord[] = [];
  let verificationErrors: string[] = [];
  try { dnsRecords = row.dns_records ? JSON.parse(row.dns_records) : []; } catch { /* corrupt cache → empty */ }
  try { verificationErrors = row.verification_errors ? JSON.parse(row.verification_errors) : []; } catch { /* */ }
  return {
    hostname: row.hostname,
    status: row.status,
    hostnameStatus: row.hostname_status,
    sslStatus: row.ssl_status,
    dnsRecords,
    verificationErrors,
    cnameTarget,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Persist the latest Cloudflare custom-hostname state onto the row (records,
// statuses, errors). Shared by create + refresh.
async function persistCfState(
  env: Env,
  projectId: string,
  hostname: string,
  cf: CfCustomHostname,
  cnameTarget: string,
): Promise<DomainRow> {
  const dnsRecords = deriveDnsRecords(cf, cnameTarget);
  const status = deriveStatus(cf);
  const verificationErrors = collectVerificationErrors(cf);
  await env.DB.prepare(
    `INSERT INTO project_custom_domains
       (project_id, hostname, cf_hostname_id, status, hostname_status, ssl_status, dns_records, verification_errors, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(project_id) DO UPDATE SET
       hostname = excluded.hostname,
       cf_hostname_id = excluded.cf_hostname_id,
       status = excluded.status,
       hostname_status = excluded.hostname_status,
       ssl_status = excluded.ssl_status,
       dns_records = excluded.dns_records,
       verification_errors = excluded.verification_errors,
       updated_at = datetime('now')`,
  ).bind(
    projectId,
    hostname,
    cf.id,
    status,
    cf.status ?? null,
    cf.ssl?.status ?? null,
    JSON.stringify(dnsRecords),
    JSON.stringify(verificationErrors),
  ).run();
  return (await env.DB.prepare("SELECT * FROM project_custom_domains WHERE project_id = ?")
    .bind(projectId).first<DomainRow>())!;
}

// A not-yet-active mapping older than this is re-polled from Cloudflare on GET,
// so the status keeps moving while the owner just watches the settings page.
const LAZY_REFRESH_AFTER_SECONDS = 60;
// An explicit POST /refresh within this window of the last update returns the
// cached row instead of hitting the Cloudflare API again (click-spam guard).
const REFRESH_THROTTLE_SECONDS = 15;

// Age of a SQLite `datetime('now')` timestamp ("YYYY-MM-DD HH:MM:SS", UTC).
// Unparseable input counts as infinitely old (safe: worst case one extra poll).
function secondsSince(sqlUtc: string): number {
  const iso = sqlUtc.includes("T") ? sqlUtc : sqlUtc.replace(" ", "T");
  const t = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(t) ? Infinity : (Date.now() - t) / 1000;
}

export async function handleCustomDomain(
  request: Request,
  env: Env,
  user: Session,
  url: URL,
): Promise<Response> {
  // /projects/:id/domain  and  /projects/:id/domain/refresh
  const m = url.pathname.match(/^\/projects\/([^/]+)\/domain(\/refresh)?$/);
  if (!m) return errorResponse(Errors.NOT_FOUND);
  const projectId = m[1];
  const isRefresh = !!m[2];

  // Caller gate: admin+ on the site (direct or via org trickle-down).
  const role = await resolveRole(env.DB, projectId, user.userId);
  if (role === null) return errorResponse(Errors.NOT_FOUND);
  if (ROLE_RANK[role] < ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);

  // Feature gate: the CUSTOM_LINK flag (admin-set) gates custom domains - they
  // are one and the same feature as the vanity slug.
  const proj = await env.DB.prepare("SELECT features FROM projects WHERE id = ?")
    .bind(projectId).first<{ features: number }>();
  if (!proj) return errorResponse(Errors.NOT_FOUND);
  if (!(proj.features & ProjectFeatures.CUSTOM_LINK)) return errorResponse(Errors.FORBIDDEN);

  const configured = customDomainsConfigured(env);
  const cnameTarget = env.CUSTOM_DOMAIN_CNAME_TARGET ?? "";

  const existing = await env.DB.prepare("SELECT * FROM project_custom_domains WHERE project_id = ?")
    .bind(projectId).first<DomainRow>();

  // POST /domain/refresh - re-poll Cloudflare and update the cached state.
  if (isRefresh) {
    if (request.method !== "POST") return errorResponse(Errors.NOT_FOUND);
    if (!existing) return errorResponse(Errors.NOT_FOUND);
    if (!configured || !existing.cf_hostname_id
      || secondsSince(existing.updated_at) < REFRESH_THROTTLE_SECONDS) {
      return okResponse({ configured, domain: rowToApi(existing, cnameTarget) });
    }
    try {
      const cf = await cfGetCustomHostname(env, existing.cf_hostname_id);
      const updated = await persistCfState(env, projectId, existing.hostname, cf, cnameTarget);
      return okResponse({ configured, domain: rowToApi(updated, cnameTarget) });
    } catch (e) {
      return cfErrorResponse(e);
    }
  }

  // GET /domain - return current mapping (or null) plus config status. A
  // not-yet-active mapping whose cache has gone stale is re-polled inline
  // (best-effort - a CF hiccup serves the cached row), so the status advances
  // without the owner having to click Refresh.
  if (request.method === "GET") {
    let row = existing;
    if (
      row && configured && row.cf_hostname_id && row.status !== "active" &&
      secondsSince(row.updated_at) >= LAZY_REFRESH_AFTER_SECONDS
    ) {
      try {
        const cf = await cfGetCustomHostname(env, row.cf_hostname_id);
        row = await persistCfState(env, projectId, row.hostname, cf, cnameTarget);
      } catch { /* serve the cached row */ }
    }
    return okResponse({
      configured,
      cnameTarget,
      domain: row ? rowToApi(row, cnameTarget) : null,
    });
  }

  // PUT /domain { hostname } - create/replace the custom hostname.
  if (request.method === "PUT") {
    if (!configured) {
      return Response.json(
        { ok: false, error: "Custom domains are not configured on this deployment." },
        { status: 503 },
      );
    }
    const body = await request.json<{ hostname?: string }>().catch(() => ({} as { hostname?: string }));
    const hostname = normalizeHostname(body.hostname ?? "");
    if (!isValidHostname(hostname)) {
      return Response.json({ ok: false, error: "Enter a valid domain, e.g. docs.example.com" }, { status: 400 });
    }
    if (isReservedHostname(hostname, cnameTarget)) {
      return Response.json({ ok: false, error: "That domain is reserved." }, { status: 400 });
    }

    // Re-submitting the hostname this site already maps: nothing to create -
    // re-creating it at Cloudflare would just bounce off a conflict. Treat it
    // as a refresh so the caller gets fresh state back.
    if (existing && existing.hostname === hostname && existing.cf_hostname_id) {
      try {
        const cf = await cfGetCustomHostname(env, existing.cf_hostname_id);
        const updated = await persistCfState(env, projectId, hostname, cf, cnameTarget);
        return okResponse({ configured, domain: rowToApi(updated, cnameTarget) });
      } catch (e) {
        return cfErrorResponse(e);
      }
    }

    // Globally unique: another site can't already own this hostname.
    const claimed = await env.DB.prepare(
      "SELECT project_id FROM project_custom_domains WHERE hostname = ? AND project_id != ?",
    ).bind(hostname, projectId).first<{ project_id: string }>();
    if (claimed) {
      return Response.json({ ok: false, error: "That domain is already in use by another site." }, { status: 409 });
    }

    // Register the NEW hostname first. If this fails, the old mapping (when
    // one exists) is untouched and keeps serving - deleting the old hostname
    // first would strand the site with neither on a create failure.
    let cf: CfCustomHostname;
    try {
      cf = await cfCreateCustomHostname(env, hostname);
    } catch (e) {
      return cfErrorResponse(e);
    }

    let updated: DomainRow;
    try {
      updated = await persistCfState(env, projectId, hostname, cf, cnameTarget);
    } catch (e) {
      // Most likely the UNIQUE(hostname) race: another site claimed the host
      // between our pre-check and the insert. Release the CF hostname we just
      // created (it has no row pointing at it) and report the conflict.
      try { await cfDeleteCustomHostname(env, cf.id); } catch { /* best-effort */ }
      if (e instanceof Error && /UNIQUE constraint/i.test(e.message)) {
        return Response.json({ ok: false, error: "That domain is already in use by another site." }, { status: 409 });
      }
      throw e;
    }

    // Only now retire the replaced Cloudflare hostname (best-effort cleanup).
    if (existing && existing.hostname !== hostname && existing.cf_hostname_id) {
      try { await cfDeleteCustomHostname(env, existing.cf_hostname_id); } catch { /* best-effort */ }
    }

    return okResponse({ configured, domain: rowToApi(updated, cnameTarget) });
  }

  // DELETE /domain - unmap and remove the Cloudflare custom hostname.
  if (request.method === "DELETE") {
    if (!existing) return okResponse({ deleted: true });
    if (configured && existing.cf_hostname_id) {
      try { await cfDeleteCustomHostname(env, existing.cf_hostname_id); } catch { /* best-effort */ }
    }
    await env.DB.prepare("DELETE FROM project_custom_domains WHERE project_id = ?").bind(projectId).run();
    return okResponse({ deleted: true });
  }

  return errorResponse(Errors.NOT_FOUND);
}

function cfErrorResponse(e: unknown): Response {
  if (e instanceof CustomDomainError) {
    return Response.json({ ok: false, error: e.message }, { status: e.status });
  }
  console.error("custom domain error", e);
  return errorResponse(Errors.INTERNAL);
}
