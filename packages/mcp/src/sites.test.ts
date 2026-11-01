import { describe, it, expect } from "vitest";
import { AnnexApiError, type AnnexClient, type KeyInfo } from "./client.js";
import { parseKeys } from "./config.js";
import { SiteRegistry, SiteSelectionError } from "./sites.js";

const ALPHA = "annx_alphaKey00000000000000000000000000000000";
const BETA = "annx_betaKey000000000000000000000000000000000";
const GAMMA = "annx_gammaKey00000000000000000000000000000000";

function info(id: string, name: string, vanitySlug: string | null): KeyInfo {
  return {
    id: `k-${id}`, name: "key", keyPrefix: "annx_xxxxxx", scope: "readwrite", canInvite: false,
    createdAt: "2026-10-01", expiresAt: null, role: "owner", site: { id, name, vanitySlug },
  };
}

// Only keyInfo is used by the registry; a secret mapped to null answers 401.
function fakeClient(byKey: Record<string, KeyInfo | null>): AnnexClient {
  return {
    async keyInfo(secret: string) {
      const i = byKey[secret];
      if (!i) throw new AnnexApiError(401, "Unauthorized");
      return i;
    },
  } as unknown as AnnexClient;
}

async function registry(raw: string, byKey: Record<string, KeyInfo | null>) {
  const r = new SiteRegistry(fakeClient(byKey), parseKeys(raw));
  await r.refresh();
  return r;
}

describe("SiteRegistry.select", () => {
  it("resolves handles, site ids, vanity slugs and exact names", async () => {
    const r = await registry(`docs=${ALPHA},${BETA}`, {
      [ALPHA]: info("s-alpha", "Alpha Docs", null),
      [BETA]: info("s-beta", "Team Wiki", "wiki"),
    });
    expect(r.select("DOCS").info.site.id).toBe("s-alpha");
    expect(r.select("wiki").info.site.id).toBe("s-beta"); // handle from slug
    expect(r.select("s-beta").info.site.id).toBe("s-beta");
    expect(r.select("alpha docs").info.site.id).toBe("s-alpha");
    expect(r.select("Team Wiki").info.site.id).toBe("s-beta");
    expect(() => r.select(undefined)).toThrow(/Several sites/);
    expect(() => r.select("nope")).toThrow(/Unknown site "nope"/);
  });

  it("refuses a revoked alias instead of falling through to another site's vanity slug", async () => {
    const r = await registry(`wiki=${ALPHA},${BETA}`, {
      [ALPHA]: info("s-alpha", "Alpha", null),
      [BETA]: info("s-beta", "Beta", "wiki"),
    });
    const wiki = r.select("wiki");
    expect(wiki.info.site.id).toBe("s-alpha");
    r.markRevoked(wiki);

    expect(() => r.select("wiki")).toThrow(SiteSelectionError);
    expect(() => r.select("Wiki")).toThrow(/Site "wiki" is revoked/);
    // The other site stays reachable by its own handle / id.
    expect(r.select("s-beta").info.site.id).toBe("s-beta");
  });

  it("refuses an unavailable alias instead of falling through to another site's name", async () => {
    const r = await registry(`handbook=${ALPHA},${BETA},${GAMMA}`, {
      [ALPHA]: null, // 401 → unavailable
      [BETA]: info("s-beta", "Handbook", null),
      [GAMMA]: info("s-gamma", "Gamma", null),
    });
    expect(() => r.select("handbook")).toThrow(/Site "handbook" is unavailable/);
    expect(r.select("handbook-2").info.site.id).toBe("s-beta");
  });
});
