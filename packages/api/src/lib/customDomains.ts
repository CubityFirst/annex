// Cloudflare-for-SaaS custom-hostname integration.
//
// A site owner maps their own domain (e.g. `docs.acme.com`) to their published
// site. We register that hostname as a Cloudflare *custom hostname* on our zone;
// Cloudflare then issues + auto-renews a DV certificate for it and routes the
// traffic to our frontend Worker (which serves the site - see the host-based
// serving path in the frontend). The customer points DNS at us with a CNAME and
// proves control via a TXT record (DCV). This module is the thin client around
// the Cloudflare API plus the pure helpers (validation + DNS-record derivation)
// that the route handler and its tests use.
//
// Zone setup (one-time, see memories/Custom-Domains.md): enable Cloudflare for
// SaaS on the zone, create an originless fallback origin, add a `*/*` Worker
// route to the frontend Worker, and set the secrets/vars below.

export interface CustomDomainEnv {
  // API token scoped to the zone with "SSL and Certificates: Edit" (custom
  // hostnames). Set via `wrangler secret put CF_API_TOKEN`.
  CF_API_TOKEN?: string;
  // The zone id of the SaaS zone (cubityfir.st).
  CF_ZONE_ID?: string;
  // The hostname customers CNAME their domain to (the fallback-origin / zone
  // hostname). e.g. "docs.cubityfir.st".
  CUSTOM_DOMAIN_CNAME_TARGET?: string;
}

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

// Shape of the bits of a Cloudflare custom_hostname object we care about.
export interface CfCustomHostname {
  id: string;
  hostname: string;
  status?: string; // hostname (DCV) status: pending | active | blocked | moved | deleted
  verification_errors?: string[];
  ssl?: {
    status?: string; // pending_validation | pending_issuance | active | ...
    validation_records?: Array<{
      txt_name?: string;
      txt_value?: string;
      http_url?: string;
      http_body?: string;
    }>;
    validation_errors?: Array<{ message?: string }>;
  };
  ownership_verification?: { type?: string; name?: string; value?: string };
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
}

export interface DnsRecord {
  type: "CNAME" | "TXT";
  name: string;
  value: string;
  note: string;
}

export class CustomDomainError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "CustomDomainError";
  }
}

// True when the worker has the config needed to talk to Cloudflare. Local dev
// without these set returns a clear "not configured" error instead of throwing.
export function customDomainsConfigured(env: CustomDomainEnv): boolean {
  return Boolean(env.CF_API_TOKEN && env.CF_ZONE_ID && env.CUSTOM_DOMAIN_CNAME_TARGET);
}

// Hostname rules: a valid DNS hostname, lowercased, no scheme/path/port, at
// least one dot (no bare apex of our own zone, no single-label hosts), <=255
// chars, each label 1-63 chars of [a-z0-9-] not starting/ending with a hyphen.
// We deliberately reject wildcards - a customer maps one concrete host.
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function normalizeHostname(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, "");
}

export function isValidHostname(raw: string): boolean {
  const host = normalizeHostname(raw);
  if (host.length === 0 || host.length > 255) return false;
  if (host.includes("*")) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every(l => LABEL.test(l))) return false;
  // Must contain a public TLD-ish final label (letters), not all-numeric (IP).
  const tld = labels[labels.length - 1];
  if (!/^[a-z][a-z0-9-]*$/.test(tld)) return false;
  return true;
}

// Derive the DNS records the customer must create from a Cloudflare custom
// hostname object. Always includes the CNAME (routes traffic to us). Adds the
// ownership-verification TXT (proves domain control before the host points at
// us) and the SSL DCV TXT record when Cloudflare provides them. Once the
// hostname is fully active these may be absent - that's expected.
export function deriveDnsRecords(
  cf: CfCustomHostname,
  cnameTarget: string,
): DnsRecord[] {
  const records: DnsRecord[] = [
    {
      type: "CNAME",
      name: cf.hostname,
      value: cnameTarget,
      note: "Points your domain at the site. (Some DNS providers call this an ALIAS at the apex.)",
    },
  ];

  const ov = cf.ownership_verification;
  if (ov?.name && ov.value && (ov.type ?? "txt").toLowerCase() === "txt") {
    records.push({
      type: "TXT",
      name: ov.name,
      value: ov.value,
      note: "Proves you control this domain. Can be removed once the domain is active.",
    });
  }

  for (const vr of cf.ssl?.validation_records ?? []) {
    if (vr.txt_name && vr.txt_value) {
      records.push({
        type: "TXT",
        name: vr.txt_name,
        value: vr.txt_value,
        note: "Validates the SSL certificate. Can be removed once the certificate is issued.",
      });
    }
  }

  return records;
}

// Collapse Cloudflare's hostname (DCV) + ssl statuses into the app-facing
// 'pending' | 'active' | 'error'. Active only when BOTH the hostname is active
// and the certificate is active; any verification error surfaces as 'error'.
export function deriveStatus(cf: CfCustomHostname): "pending" | "active" | "error" {
  const errs = (cf.verification_errors ?? []).filter(Boolean);
  const sslErrs = (cf.ssl?.validation_errors ?? []).map(e => e?.message).filter(Boolean);
  if (errs.length > 0 || sslErrs.length > 0) return "error";
  if (cf.status === "active" && cf.ssl?.status === "active") return "active";
  return "pending";
}

export function collectVerificationErrors(cf: CfCustomHostname): string[] {
  return [
    ...(cf.verification_errors ?? []),
    ...((cf.ssl?.validation_errors ?? []).map(e => e?.message).filter((m): m is string => !!m)),
  ];
}

async function cfFetch<T>(
  env: CustomDomainEnv,
  path: string,
  init: RequestInit,
): Promise<T> {
  const res = await fetch(`${CF_API_BASE}/zones/${env.CF_ZONE_ID}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  let json: CfEnvelope<T>;
  try {
    json = await res.json<CfEnvelope<T>>();
  } catch {
    throw new CustomDomainError(`Cloudflare returned a non-JSON response (${res.status})`);
  }
  if (!json.success || !json.result) {
    const msg = json.errors?.map(e => e.message).filter(Boolean).join("; ") || `Cloudflare API error (${res.status})`;
    // 81xx codes for an already-existing hostname → surface as a 409-ish conflict.
    const conflict = json.errors?.some(e => e.code === 1406 || e.code === 1407);
    throw new CustomDomainError(msg, conflict ? 409 : 502);
  }
  return json.result;
}

export async function cfCreateCustomHostname(
  env: CustomDomainEnv,
  hostname: string,
): Promise<CfCustomHostname> {
  return cfFetch<CfCustomHostname>(env, "/custom_hostnames", {
    method: "POST",
    body: JSON.stringify({
      hostname,
      ssl: {
        method: "txt",
        type: "dv",
        settings: { min_tls_version: "1.2" },
        bundle_method: "ubiquitous",
        wildcard: false,
      },
    }),
  });
}

export async function cfGetCustomHostname(
  env: CustomDomainEnv,
  id: string,
): Promise<CfCustomHostname> {
  return cfFetch<CfCustomHostname>(env, `/custom_hostnames/${id}`, { method: "GET" });
}

export async function cfDeleteCustomHostname(
  env: CustomDomainEnv,
  id: string,
): Promise<void> {
  // DELETE returns `{ id }` as the result; we don't need it. A 404 here means
  // it's already gone, which is fine for our delete flow - swallow it.
  try {
    await cfFetch<{ id: string }>(env, `/custom_hostnames/${id}`, { method: "DELETE" });
  } catch (e) {
    if (e instanceof CustomDomainError && e.status === 502) {
      // Best-effort: if CF says it doesn't exist, treat as deleted.
      return;
    }
    throw e;
  }
}

// Best-effort deregistration of a site's Cloudflare custom hostname, to be
// called BEFORE the project (and its cascading `project_custom_domains` row) is
// deleted - `cf_hostname_id` lives only in that row, so once it cascades away we
// can no longer tell Cloudflare to release the hostname.
//
// Without this, deleting a site orphans the custom hostname in the CF SaaS zone:
// it keeps billing as an active custom hostname, and because the hostname is
// globally unique in the zone, Cloudflare will reject any later attempt to
// re-add it from another site (even though our own DB row is long gone).
//
// No-op when custom domains aren't configured (no CF creds) or the site has no
// mapped domain. Never throws - site deletion must not be blocked by a CF
// hiccup; an orphaned hostname is recoverable, a half-deleted site is worse.
export async function releaseCustomDomain(
  env: CustomDomainEnv & { DB: D1Database },
  projectId: string,
): Promise<void> {
  if (!customDomainsConfigured(env)) return;
  try {
    const row = await env.DB.prepare(
      "SELECT cf_hostname_id FROM project_custom_domains WHERE project_id = ?",
    ).bind(projectId).first<{ cf_hostname_id: string | null }>();
    if (row?.cf_hostname_id) {
      await cfDeleteCustomHostname(env, row.cf_hostname_id);
    }
  } catch {
    // Best-effort: never block project deletion on CF cleanup.
  }
}

// Fully unmap a site's custom domain WITHOUT deleting the site: deregister the
// Cloudflare custom hostname (best-effort) AND drop the `project_custom_domains`
// row. Unlike `releaseCustomDomain` (which runs before a project delete and
// lets the cascade drop the row), this owns the row deletion itself, so it's
// the right call for an admin "remove custom domain" action or any standalone
// unmap. Returns the removed hostname, or null if the site had none mapped.
//
// The CF deregistration is best-effort (a CF hiccup must not leave the DB row
// orphaned), but the DB row IS always deleted - that's the user-visible effect
// the caller asked for.
export async function removeCustomDomain(
  env: CustomDomainEnv & { DB: D1Database },
  projectId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT hostname, cf_hostname_id FROM project_custom_domains WHERE project_id = ?",
  ).bind(projectId).first<{ hostname: string; cf_hostname_id: string | null }>();
  if (!row) return null;
  if (customDomainsConfigured(env) && row.cf_hostname_id) {
    try {
      await cfDeleteCustomHostname(env, row.cf_hostname_id);
    } catch {
      // Best-effort CF cleanup; still drop the DB row below.
    }
  }
  await env.DB.prepare("DELETE FROM project_custom_domains WHERE project_id = ?").bind(projectId).run();
  return row.hostname;
}
