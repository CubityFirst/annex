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

// The registrable apex of our own SaaS zone, derived from the CNAME target's
// last two labels (e.g. "docs.cubityfir.st" → "cubityfir.st"). A customer must
// not claim our own zone or any host under it as their "custom" domain.
function ownZoneApex(cnameTarget: string): string {
  return cnameTarget.split(".").slice(-2).join(".");
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
    if (!configured || !existing.cf_hostname_id) {
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

  // GET /domain - return current mapping (or null) plus config status.
  if (request.method === "GET") {
    return okResponse({
      configured,
      cnameTarget,
      domain: existing ? rowToApi(existing, cnameTarget) : null,
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
    const apex = ownZoneApex(cnameTarget);
    if (hostname === apex || hostname.endsWith(`.${apex}`)) {
      return Response.json({ ok: false, error: "That domain is reserved." }, { status: 400 });
    }

    // Globally unique: another site can't already own this hostname.
    const claimed = await env.DB.prepare(
      "SELECT project_id FROM project_custom_domains WHERE hostname = ? AND project_id != ?",
    ).bind(hostname, projectId).first<{ project_id: string }>();
    if (claimed) {
      return Response.json({ ok: false, error: "That domain is already in use by another site." }, { status: 409 });
    }

    // If this site already maps a different hostname, retire the old Cloudflare
    // custom hostname before creating the new one (best-effort cleanup).
    if (existing && existing.hostname !== hostname && existing.cf_hostname_id) {
      try { await cfDeleteCustomHostname(env, existing.cf_hostname_id); } catch { /* best-effort */ }
    }

    try {
      const cf = await cfCreateCustomHostname(env, hostname);
      const updated = await persistCfState(env, projectId, hostname, cf, cnameTarget);
      return okResponse({ configured, domain: rowToApi(updated, cnameTarget) });
    } catch (e) {
      return cfErrorResponse(e);
    }
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
