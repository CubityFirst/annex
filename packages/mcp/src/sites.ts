// The set of sites this MCP server can act on: one entry per configured key.
//
// Every key is bound server-side to exactly one site, so "multiple sites" means
// "multiple keys". Tools pick a site by handle; the registry maps that to the
// key and the key alone decides which site Annex acts on. There is no way to
// aim a key at a different site, by design.

import { AnnexApiError, type AnnexClient, type KeyInfo } from "./client.js";
import { keyLabel, type KeyEntry } from "./config.js";

export type SiteStatus = "ready" | "unavailable" | "revoked";

export interface SiteEntry {
  /** Stable handle tools accept as `site`. */
  handle: string;
  /** True until a real handle (alias / slug / name) has been assigned. */
  provisional: boolean;
  alias: string | null;
  secret: string;
  keyLabel: string;
  status: SiteStatus;
  info: KeyInfo | null;
  error: string | null;
}

/** Public, secret-free view of an entry. */
export interface SiteView {
  site: string;
  status: SiteStatus;
  key: string;
  name?: string;
  scope?: "read" | "readwrite";
  canInvite?: boolean;
  role?: string;
  expiresAt?: string | null;
  error?: string;
}

export class SiteSelectionError extends Error {}

function slugify(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function describeResolveError(err: unknown): string {
  if (err instanceof AnnexApiError) {
    if (err.status === 401) return "Key rejected: invalid, revoked or expired. Remove it from ANNEX_API_KEYS.";
    if (err.status === 403) return "The key's owner no longer has access to its site.";
    return err.message;
  }
  return (err as Error).message;
}

export class SiteRegistry {
  readonly entries: SiteEntry[];

  constructor(private readonly client: AnnexClient, keys: KeyEntry[]) {
    this.entries = keys.map((k, i) => ({
      // "#" can never appear in an alias, slug or site id, so a provisional
      // handle can never collide with a real one.
      handle: k.alias ?? `key#${i + 1}`,
      provisional: k.alias === null,
      alias: k.alias,
      secret: k.secret,
      keyLabel: keyLabel(k.secret),
      status: "unavailable",
      info: null,
      error: "Not resolved yet.",
    }));
  }

  /** Re-resolve every live key (site, scope, owner's role). Never throws. */
  async refresh(): Promise<void> {
    await Promise.all(
      this.entries.filter(e => e.status !== "revoked").map(async e => {
        try {
          e.info = await this.client.keyInfo(e.secret);
          e.status = "ready";
          e.error = null;
        } catch (err) {
          e.status = "unavailable";
          e.error = describeResolveError(err);
          // A 403 means the owner lost access: keep no stale site details.
          if (err instanceof AnnexApiError && (err.status === 401 || err.status === 403)) e.info = null;
        }
      }),
    );
    this.assignHandles();
  }

  // Give resolved keys a readable handle (alias > vanity slug > site name >
  // site id), once - handles never change after assignment, so a handle the
  // model saw earlier keeps meaning the same key.
  private assignHandles(): void {
    const taken = new Set(this.entries.filter(e => !e.provisional).map(e => e.handle.toLowerCase()));
    for (const e of this.entries) {
      if (!e.provisional || !e.info) continue;
      const base = e.info.site.vanitySlug || slugify(e.info.site.name) || e.info.site.id;
      let handle = base;
      for (let n = 2; taken.has(handle.toLowerCase()); n++) handle = `${base}-${n}`;
      taken.add(handle.toLowerCase());
      e.handle = handle;
      e.provisional = false;
    }
  }

  hasUnavailable(): boolean {
    return this.entries.some(e => e.status === "unavailable");
  }

  list(): SiteView[] {
    return this.entries.map(e => ({
      site: e.handle,
      status: e.status,
      key: e.keyLabel,
      ...(e.info
        ? {
            name: e.info.site.name,
            scope: e.info.scope,
            canInvite: e.info.canInvite,
            role: e.info.role,
            expiresAt: e.info.expiresAt,
          }
        : {}),
      ...(e.error ? { error: e.error } : {}),
    }));
  }

  private readyHandles(): string {
    const ready = this.entries.filter(e => e.status === "ready").map(e => `"${e.handle}"`);
    return ready.length ? ready.join(", ") : "(none - run list_sites to see why)";
  }

  /**
   * Resolve a tool's `site` argument to a ready entry. Matches the handle,
   * site id, vanity slug or exact site name (case-insensitive). With a single
   * ready site, `site` may be omitted.
   */
  select(site: string | undefined): SiteEntry & { info: KeyInfo } {
    const ready = this.entries.filter((e): e is SiteEntry & { info: KeyInfo } => e.status === "ready" && e.info !== null);
    const wanted = site?.trim();

    if (!wanted) {
      if (ready.length === 1) return ready[0];
      if (ready.length === 0) throw new SiteSelectionError("No usable Annex sites. Run list_sites to see each key's status.");
      throw new SiteSelectionError(`Several sites are configured; pass "site" (one of ${this.readyHandles()}).`);
    }

    const w = wanted.toLowerCase();
    // Handles are unique across ALL entries and take precedence: a handle owned
    // by a revoked/unavailable key must never fall through to another site whose
    // slug or name happens to equal it.
    const owner = this.entries.find(e => e.handle.toLowerCase() === w);
    if (owner) {
      if (owner.status === "ready" && owner.info) return owner as SiteEntry & { info: KeyInfo };
      throw new SiteSelectionError(`Site "${owner.handle}" is ${owner.status}: ${owner.error ?? ""}`.trim());
    }
    const matches = ready.filter(
      e => e.info.site.id === wanted || e.info.site.vanitySlug?.toLowerCase() === w || e.info.site.name.toLowerCase() === w,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new SiteSelectionError(
        `"${wanted}" matches several keys (${matches.map(e => `"${e.handle}"`).join(", ")}); use one of those handles.`,
      );
    }

    throw new SiteSelectionError(`Unknown site "${wanted}". Available: ${this.readyHandles()}.`);
  }

  markRevoked(entry: SiteEntry): void {
    entry.status = "revoked";
    entry.error = "Revoked via revoke_key. Remove this key from ANNEX_API_KEYS.";
  }

  markUnavailable(entry: SiteEntry, err: unknown): void {
    entry.status = "unavailable";
    entry.error = describeResolveError(err);
    entry.info = null;
  }
}
