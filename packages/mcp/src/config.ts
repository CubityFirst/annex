// Environment → validated server config. Pure (takes the env object), so it is
// unit-testable and never touches process state itself.
//
//   ANNEX_API_KEYS      one or more site-scoped keys, separated by commas,
//                       whitespace or newlines. Each entry is either a bare key
//                       (`annx_…`) or `alias=annx_…`; the alias becomes the
//                       site handle tools accept as their `site` argument.
//   ANNEX_API_KEY       a single key (merged with ANNEX_API_KEYS, for the
//                       common one-site case).
//   ANNEX_API_URL       API base, default https://docs.cubityfir.st/api. Must be
//                       https unless it points at loopback (local dev).
//   ANNEX_MCP_READ_ONLY "1"/"true" hides every content-mutating tool even when a
//                       key's scope would allow writes.

export const API_KEY_PREFIX = "annx_";
export const DEFAULT_API_URL = "https://docs.cubityfir.st/api";

export interface KeyEntry {
  /** Operator-chosen handle, if given as `alias=annx_…`. */
  alias: string | null;
  secret: string;
}

export interface Config {
  apiUrl: string;
  keys: KeyEntry[];
  readOnly: boolean;
}

export class ConfigError extends Error {}

const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
// The random part of a real key is base64url; anything else is a paste error.
const SECRET_RE = /^annx_[A-Za-z0-9_-]{16,}$/;

/** Display-safe identifier for a secret - never log or return the full key. */
export function keyLabel(secret: string): string {
  return secret.slice(0, API_KEY_PREFIX.length + 6) + "…";
}

export function parseKeys(raw: string): KeyEntry[] {
  const out: KeyEntry[] = [];
  const seenSecrets = new Set<string>();
  const seenAliases = new Set<string>();
  for (const token of raw.split(/[\s,]+/).filter(Boolean)) {
    const eq = token.indexOf("=");
    const alias = eq === -1 ? null : token.slice(0, eq);
    const secret = eq === -1 ? token : token.slice(eq + 1);

    if (!SECRET_RE.test(secret)) {
      // Never echo the token: it may be a real (mis-pasted) secret.
      throw new ConfigError(
        `ANNEX_API_KEYS entry #${out.length + 1} is not an Annex API key (expected "annx_…" or "alias=annx_…").`,
      );
    }
    if (alias !== null) {
      // Never echo the alias either: it may be a mis-pasted secret.
      const entry = `ANNEX_API_KEYS entry #${out.length + 1}`;
      if (alias.toLowerCase().startsWith(API_KEY_PREFIX)) {
        throw new ConfigError(`${entry} has an API key as its alias; use "alias=annx_…" with a short name as the alias.`);
      }
      if (!ALIAS_RE.test(alias)) {
        throw new ConfigError(`${entry} has an invalid alias: use letters, digits, "-" or "_" (max 64).`);
      }
      const lower = alias.toLowerCase();
      if (seenAliases.has(lower)) throw new ConfigError(`${entry} repeats an alias already used by an earlier entry.`);
      seenAliases.add(lower);
    }
    if (seenSecrets.has(secret)) continue; // same key listed twice → once
    seenSecrets.add(secret);
    out.push({ alias, secret });
  }
  return out;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

export function parseApiUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim() || DEFAULT_API_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`ANNEX_API_URL is not a valid URL: ${value}`);
  }
  // Keys are bearer secrets: refuse to send them in cleartext anywhere but loopback.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new ConfigError("ANNEX_API_URL must use https (http is only allowed for localhost).");
  }
  if (url.search || url.hash) throw new ConfigError("ANNEX_API_URL must not include a query string or fragment.");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const keys = parseKeys([env.ANNEX_API_KEY ?? "", env.ANNEX_API_KEYS ?? ""].join(","));
  if (keys.length === 0) {
    throw new ConfigError(
      "No API keys configured. Set ANNEX_API_KEYS (or ANNEX_API_KEY) to one or more keys from " +
        "Site Settings → Developer → API Keys.",
    );
  }
  return { apiUrl: parseApiUrl(env.ANNEX_API_URL), keys, readOnly: truthy(env.ANNEX_MCP_READ_ONLY) };
}
