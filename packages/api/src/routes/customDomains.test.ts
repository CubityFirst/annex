import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleCustomDomain } from "./customDomains";

vi.mock("../lib/access", () => ({ resolveRole: vi.fn() }));
// Partial-mock the Cloudflare client: keep the pure helpers + CustomDomainError
// real (so deriveStatus / isValidHostname / instanceof checks behave for real),
// stub only the three functions that actually call Cloudflare.
vi.mock("../lib/customDomains", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/customDomains")>()),
  cfCreateCustomHostname: vi.fn(),
  cfGetCustomHostname: vi.fn(),
  cfDeleteCustomHostname: vi.fn(),
}));

import { resolveRole } from "../lib/access";
import {
  cfCreateCustomHostname,
  cfGetCustomHostname,
  cfDeleteCustomHostname,
  CustomDomainError,
  type CfCustomHostname,
} from "../lib/customDomains";

const user = { userId: "user-1", email: "a@example.com" } as unknown as Parameters<typeof handleCustomDomain>[2];

const CNAME_TARGET = "docs.cubityfir.st";

function makeEnv(opts?: { configured?: boolean }) {
  const configured = opts?.configured ?? true;
  const firsts: unknown[] = [];
  const runs: unknown[] = [];
  const first = vi.fn(() => Promise.resolve(firsts.shift() ?? null));
  const all = vi.fn(() => Promise.resolve({ results: [] }));
  const run = vi.fn(() => Promise.resolve(runs.shift() ?? { meta: { changes: 1 } }));
  const bind = vi.fn(() => ({ first, all, run }));
  const prepare = vi.fn(() => ({ bind }));
  return {
    env: {
      DB: { prepare },
      CF_API_TOKEN: configured ? "cf-token" : undefined,
      CF_ZONE_ID: configured ? "zone-1" : undefined,
      CUSTOM_DOMAIN_CNAME_TARGET: configured ? CNAME_TARGET : undefined,
    } as unknown as Parameters<typeof handleCustomDomain>[1],
    run,
    queueFirst: (v: unknown) => firsts.push(v),
  };
}

function call(env: Parameters<typeof handleCustomDomain>[1], method: string, path: string, body?: unknown) {
  const url = new URL(`http://localhost${path}`);
  return handleCustomDomain(
    new Request(url.toString(), {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
    env, user, url,
  );
}

function makeRow(over?: Partial<Record<string, unknown>>) {
  return {
    project_id: "p1",
    hostname: "docs.example.com",
    cf_hostname_id: "cf-1",
    status: "pending",
    hostname_status: "pending",
    ssl_status: "pending_validation",
    dns_records: null,
    verification_errors: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-02",
    ...over,
  };
}

const cfResult: CfCustomHostname = {
  id: "cf-new",
  hostname: "docs.example.com",
  status: "pending",
  ssl: { status: "pending_validation" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveRole).mockResolvedValue("admin");
  vi.mocked(cfCreateCustomHostname).mockResolvedValue(cfResult);
  vi.mocked(cfGetCustomHostname).mockResolvedValue(cfResult);
  vi.mocked(cfDeleteCustomHostname).mockResolvedValue(undefined);
});

describe("handleCustomDomain routing + gates", () => {
  it("404s on a non-matching path", async () => {
    const { env } = makeEnv();
    const res = await call(env, "GET", "/projects/p1/other");
    expect(res.status).toBe(404);
  });

  it("404s when the caller isn't a member", async () => {
    vi.mocked(resolveRole).mockResolvedValue(null);
    const { env } = makeEnv();
    const res = await call(env, "GET", "/projects/p1/domain");
    expect(res.status).toBe(404);
  });

  it("403s for a member below admin", async () => {
    vi.mocked(resolveRole).mockResolvedValue("editor");
    const { env } = makeEnv();
    const res = await call(env, "GET", "/projects/p1/domain");
    expect(res.status).toBe(403);
  });

  it("404s when the project doesn't exist", async () => {
    const { env } = makeEnv(); // features first() → null
    const res = await call(env, "GET", "/projects/p1/domain");
    expect(res.status).toBe(404);
  });

  it("403s when the CUSTOM_LINK feature is off", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 0 });
    const res = await call(env, "GET", "/projects/p1/domain");
    expect(res.status).toBe(403);
  });

  it("404s on an unsupported method", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 1 }); // project
    queueFirst(null); // existing
    const res = await call(env, "PATCH", "/projects/p1/domain");
    expect(res.status).toBe(404);
  });
});

describe("handleCustomDomain GET", () => {
  it("returns null domain + config status when nothing is mapped", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(null);
    const res = await call(env, "GET", "/projects/p1/domain");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { configured: boolean; cnameTarget: string; domain: unknown } };
    expect(json.data.configured).toBe(true);
    expect(json.data.cnameTarget).toBe(CNAME_TARGET);
    expect(json.data.domain).toBeNull();
  });

  it("returns the mapped domain when one exists (active → no CF poll)", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(makeRow({ status: "active" }));
    const res = await call(env, "GET", "/projects/p1/domain");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { domain: { hostname: string } } };
    expect(json.data.domain.hostname).toBe("docs.example.com");
    expect(cfGetCustomHostname).not.toHaveBeenCalled();
  });

  it("lazily re-polls Cloudflare for a stale non-active mapping", async () => {
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(makeRow()); // pending, stale updated_at
    queueFirst(makeRow({ status: "active" })); // persisted re-read
    const res = await call(env, "GET", "/projects/p1/domain");
    expect(res.status).toBe(200);
    expect(cfGetCustomHostname).toHaveBeenCalledWith(env, "cf-1");
    expect(run).toHaveBeenCalled();
    const json = (await res.json()) as { data: { domain: { status: string } } };
    expect(json.data.domain.status).toBe("active");
  });

  it("does not re-poll a freshly-updated pending mapping", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(makeRow({ updated_at: new Date().toISOString() }));
    const res = await call(env, "GET", "/projects/p1/domain");
    expect(res.status).toBe(200);
    expect(cfGetCustomHostname).not.toHaveBeenCalled();
  });

  it("serves the cached row when the lazy re-poll fails", async () => {
    vi.mocked(cfGetCustomHostname).mockRejectedValue(new CustomDomainError("boom", 502));
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(makeRow());
    const res = await call(env, "GET", "/projects/p1/domain");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { domain: { hostname: string; status: string } } };
    expect(json.data.domain.hostname).toBe("docs.example.com");
    expect(json.data.domain.status).toBe("pending");
  });
});

describe("handleCustomDomain PUT", () => {
  it("503s when custom domains aren't configured", async () => {
    const { env, queueFirst } = makeEnv({ configured: false });
    queueFirst({ features: 1 });
    queueFirst(null);
    const res = await call(env, "PUT", "/projects/p1/domain", { hostname: "docs.example.com" });
    expect(res.status).toBe(503);
    expect(cfCreateCustomHostname).not.toHaveBeenCalled();
  });

  it("400s on an invalid hostname", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(null);
    const res = await call(env, "PUT", "/projects/p1/domain", { hostname: "not a host" });
    expect(res.status).toBe(400);
  });

  it("400s when claiming our own reserved zone", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(null);
    const res = await call(env, "PUT", "/projects/p1/domain", { hostname: "foo.cubityfir.st" });
    expect(res.status).toBe(400);
  });

  it("400s when claiming a platform zone not derived from the CNAME target", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(null);
    const res = await call(env, "PUT", "/projects/p1/domain", { hostname: "evil.workers.dev" });
    expect(res.status).toBe(400);
    expect(cfCreateCustomHostname).not.toHaveBeenCalled();
  });

  it("treats re-submitting the already-mapped hostname as a refresh, not a create", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(makeRow()); // existing maps the same hostname
    queueFirst(makeRow()); // persisted re-read
    const res = await call(env, "PUT", "/projects/p1/domain", { hostname: "docs.example.com" });
    expect(res.status).toBe(200);
    expect(cfGetCustomHostname).toHaveBeenCalledWith(env, "cf-1");
    expect(cfCreateCustomHostname).not.toHaveBeenCalled();
    expect(cfDeleteCustomHostname).not.toHaveBeenCalled();
  });

  it("409s when another site already owns the hostname", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(null); // existing
    queueFirst({ project_id: "other" }); // claimed
    const res = await call(env, "PUT", "/projects/p1/domain", { hostname: "docs.example.com" });
    expect(res.status).toBe(409);
  });

  it("creates the custom hostname and persists state", async () => {
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(null); // existing
    queueFirst(null); // claimed
    queueFirst(makeRow()); // persisted re-read
    const res = await call(env, "PUT", "/projects/p1/domain", { hostname: "docs.example.com" });
    expect(res.status).toBe(200);
    expect(cfCreateCustomHostname).toHaveBeenCalledWith(env, "docs.example.com");
    expect(run).toHaveBeenCalled();
  });

  it("retires the old Cloudflare hostname only AFTER the new one is registered", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(makeRow({ hostname: "old.example.com", cf_hostname_id: "cf-old" }));
    queueFirst(null); // claimed
    queueFirst(makeRow()); // persisted re-read
    const res = await call(env, "PUT", "/projects/p1/domain", { hostname: "docs.example.com" });
    expect(res.status).toBe(200);
    expect(cfDeleteCustomHostname).toHaveBeenCalledWith(env, "cf-old");
    expect(cfCreateCustomHostname).toHaveBeenCalled();
    const createOrder = vi.mocked(cfCreateCustomHostname).mock.invocationCallOrder[0];
    const deleteOrder = vi.mocked(cfDeleteCustomHostname).mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(deleteOrder);
  });

  it("keeps the old mapping untouched when creating the replacement fails", async () => {
    vi.mocked(cfCreateCustomHostname).mockRejectedValue(new CustomDomainError("cf down", 502));
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(makeRow({ hostname: "old.example.com", cf_hostname_id: "cf-old" }));
    queueFirst(null); // claimed
    const res = await call(env, "PUT", "/projects/p1/domain", { hostname: "docs.example.com" });
    expect(res.status).toBe(502);
    expect(cfDeleteCustomHostname).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("409s and releases the just-created CF hostname on a unique-hostname race", async () => {
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(null); // existing
    queueFirst(null); // claimed pre-check passes (the race)
    run.mockRejectedValueOnce(new Error("UNIQUE constraint failed: project_custom_domains.hostname"));
    const res = await call(env, "PUT", "/projects/p1/domain", { hostname: "docs.example.com" });
    expect(res.status).toBe(409);
    expect(cfDeleteCustomHostname).toHaveBeenCalledWith(env, "cf-new");
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/already in use/);
  });

  it("surfaces a CustomDomainError from Cloudflare", async () => {
    vi.mocked(cfCreateCustomHostname).mockRejectedValue(new CustomDomainError("already exists", 409));
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(null);
    queueFirst(null);
    const res = await call(env, "PUT", "/projects/p1/domain", { hostname: "docs.example.com" });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("already exists");
  });
});

describe("handleCustomDomain POST /refresh", () => {
  it("404s when refresh is hit with a non-POST method", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(makeRow());
    const res = await call(env, "GET", "/projects/p1/domain/refresh");
    expect(res.status).toBe(404);
  });

  it("404s refresh when nothing is mapped", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(null);
    const res = await call(env, "POST", "/projects/p1/domain/refresh");
    expect(res.status).toBe(404);
  });

  it("returns the cached row without calling Cloudflare when there's no cf id", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(makeRow({ cf_hostname_id: null }));
    const res = await call(env, "POST", "/projects/p1/domain/refresh");
    expect(res.status).toBe(200);
    expect(cfGetCustomHostname).not.toHaveBeenCalled();
  });

  it("throttles refresh: returns the cached row without a CF call right after an update", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(makeRow({ updated_at: new Date().toISOString() }));
    const res = await call(env, "POST", "/projects/p1/domain/refresh");
    expect(res.status).toBe(200);
    expect(cfGetCustomHostname).not.toHaveBeenCalled();
  });

  it("re-polls Cloudflare and persists the refreshed state", async () => {
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(makeRow());
    queueFirst(makeRow()); // persisted re-read
    const res = await call(env, "POST", "/projects/p1/domain/refresh");
    expect(res.status).toBe(200);
    expect(cfGetCustomHostname).toHaveBeenCalledWith(env, "cf-1");
    expect(run).toHaveBeenCalled();
  });

  it("surfaces a CustomDomainError on refresh", async () => {
    vi.mocked(cfGetCustomHostname).mockRejectedValue(new CustomDomainError("boom", 502));
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(makeRow());
    const res = await call(env, "POST", "/projects/p1/domain/refresh");
    expect(res.status).toBe(502);
  });
});

describe("handleCustomDomain DELETE", () => {
  it("is a no-op success when nothing is mapped", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(null);
    const res = await call(env, "DELETE", "/projects/p1/domain");
    expect(res.status).toBe(200);
    expect(cfDeleteCustomHostname).not.toHaveBeenCalled();
  });

  it("removes the Cloudflare hostname and the row", async () => {
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ features: 1 });
    queueFirst(makeRow());
    const res = await call(env, "DELETE", "/projects/p1/domain");
    expect(res.status).toBe(200);
    expect(cfDeleteCustomHostname).toHaveBeenCalledWith(env, "cf-1");
    expect(run).toHaveBeenCalled();
  });
});
