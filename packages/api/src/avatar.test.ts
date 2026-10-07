import { describe, it, expect } from "vitest";
import { parseVariant, resolveAvatar, deleteAllAvatarVariants, avatarKey } from "./avatar";

const U = "11111111-1111-4111-8111-111111111111";

// Minimal in-memory R2 stand-in. Tracks puts/deletes so we can assert the
// one-time legacy migration writes -dark and removes the legacy object.
interface Stored { body: ArrayBuffer; contentType: string }

class FakeR2 {
  store = new Map<string, Stored>();
  puts: string[] = [];
  deletes: string[] = [];

  constructor(seed: Record<string, [string, string]> = {}) {
    for (const [k, [text, ct]] of Object.entries(seed)) {
      this.store.set(k, { body: enc(text), contentType: ct });
    }
  }

  async get(key: string) {
    const e = this.store.get(key);
    if (!e) return null;
    return { arrayBuffer: async () => e.body, httpMetadata: { contentType: e.contentType } };
  }

  async put(key: string, body: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
    this.puts.push(key);
    this.store.set(key, { body, contentType: opts?.httpMetadata?.contentType ?? "application/octet-stream" });
  }

  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      this.deletes.push(k);
      this.store.delete(k);
    }
  }
}

function enc(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer;
}
function dec(b: ArrayBuffer): string {
  return new TextDecoder().decode(b);
}
function mk(seed?: Record<string, [string, string]>) {
  const fake = new FakeR2(seed);
  return { fake, bucket: fake as unknown as R2Bucket };
}

describe("parseVariant", () => {
  it("maps only the literal 'light' to light; everything else is dark", () => {
    expect(parseVariant("light")).toBe("light");
    expect(parseVariant("dark")).toBe("dark");
    expect(parseVariant(null)).toBe("dark");
    expect(parseVariant(undefined)).toBe("dark");
    expect(parseVariant("LIGHT")).toBe("dark");
    expect(parseVariant("")).toBe("dark");
  });
});

describe("resolveAvatar", () => {
  it("returns the dark object for a dark request", async () => {
    const { fake, bucket } = mk({ "avatars/11111111-1111-4111-8111-111111111111-dark": ["DARK", "image/webp"] });
    const r = await resolveAvatar(bucket, U, "dark");
    expect(r && dec(r.body)).toBe("DARK");
    expect(r?.contentType).toBe("image/webp");
    expect(fake.puts).toEqual([]);
    expect(fake.deletes).toEqual([]);
  });

  it("returns the light object for a light request", async () => {
    const { bucket } = mk({ "avatars/11111111-1111-4111-8111-111111111111-light": ["LIGHT", "image/png"] });
    const r = await resolveAvatar(bucket, U, "light");
    expect(r && dec(r.body)).toBe("LIGHT");
    expect(r?.contentType).toBe("image/png");
  });

  it("falls back light -> dark when no light variant exists", async () => {
    const { bucket } = mk({ "avatars/11111111-1111-4111-8111-111111111111-dark": ["DARK", "image/webp"] });
    const r = await resolveAvatar(bucket, U, "light");
    expect(r && dec(r.body)).toBe("DARK");
  });

  it("falls back dark -> light when no dark variant exists (bidirectional)", async () => {
    const { fake, bucket } = mk({ "avatars/11111111-1111-4111-8111-111111111111-light": ["LIGHT", "image/webp"] });
    const r = await resolveAvatar(bucket, U, "dark");
    expect(r && dec(r.body)).toBe("LIGHT");
    // No migration writes when only a light variant is present.
    expect(fake.puts).toEqual([]);
  });

  it("migrates a legacy object to -dark and deletes the legacy key (dark request)", async () => {
    const { fake, bucket } = mk({ "avatars/11111111-1111-4111-8111-111111111111": ["LEGACY", "image/gif"] });
    const r = await resolveAvatar(bucket, U, "dark");
    expect(r && dec(r.body)).toBe("LEGACY");
    expect(r?.contentType).toBe("image/gif");
    expect(fake.puts).toContain("avatars/11111111-1111-4111-8111-111111111111-dark");
    expect(fake.deletes).toContain("avatars/11111111-1111-4111-8111-111111111111");
    expect(fake.store.has("avatars/11111111-1111-4111-8111-111111111111")).toBe(false);
    const migrated = fake.store.get("avatars/11111111-1111-4111-8111-111111111111-dark");
    expect(migrated && dec(migrated.body)).toBe("LEGACY");
    expect(migrated?.contentType).toBe("image/gif");
  });

  it("migrates the legacy object even when the request is for light", async () => {
    const { fake, bucket } = mk({ "avatars/11111111-1111-4111-8111-111111111111": ["LEGACY", "image/jpeg"] });
    const r = await resolveAvatar(bucket, U, "light");
    expect(r && dec(r.body)).toBe("LEGACY");
    expect(fake.store.has("avatars/11111111-1111-4111-8111-111111111111-dark")).toBe(true);
    expect(fake.store.has("avatars/11111111-1111-4111-8111-111111111111")).toBe(false);
  });

  it("is idempotent: a second resolve serves -dark and does not re-migrate", async () => {
    const { fake, bucket } = mk({ "avatars/11111111-1111-4111-8111-111111111111": ["LEGACY", "image/gif"] });
    await resolveAvatar(bucket, U, "dark");
    fake.puts.length = 0;
    fake.deletes.length = 0;
    const r = await resolveAvatar(bucket, U, "dark");
    expect(r && dec(r.body)).toBe("LEGACY");
    expect(fake.puts).toEqual([]);
    expect(fake.deletes).toEqual([]);
  });

  it("returns null when the user has no avatar at all", async () => {
    const { bucket } = mk();
    expect(await resolveAvatar(bucket, U, "dark")).toBeNull();
    expect(await resolveAvatar(bucket, U, "light")).toBeNull();
  });
});

describe("deleteAllAvatarVariants", () => {
  it("removes both variants and any legacy object", async () => {
    const { fake, bucket } = mk({
      "avatars/11111111-1111-4111-8111-111111111111-dark": ["D", "image/webp"],
      "avatars/11111111-1111-4111-8111-111111111111-light": ["L", "image/webp"],
      "avatars/11111111-1111-4111-8111-111111111111": ["LEG", "image/gif"],
    });
    await deleteAllAvatarVariants(bucket, U);
    expect(fake.store.size).toBe(0);
    expect(fake.deletes).toEqual(
      expect.arrayContaining([avatarKey(U, "dark"), avatarKey(U, "light"), "avatars/11111111-1111-4111-8111-111111111111"]),
    );
  });
});

describe("resolveAvatar id validation", () => {
  it("rejects a non-UUID id without touching another user's objects", async () => {
    // `<victim>-dark` must not be treated as a legacy key for the victim's
    // real dark avatar (which would copy it away and delete it).
    const { fake, bucket } = mk({ [`avatars/${U}-dark`]: ["DARK", "image/webp"] });
    expect(await resolveAvatar(bucket, `${U}-dark`, "dark")).toBeNull();
    expect(await resolveAvatar(bucket, `${U}-light`, "light")).toBeNull();
    expect(fake.deletes).toEqual([]);
    expect(fake.puts).toEqual([]);
    expect(fake.store.has(`avatars/${U}-dark`)).toBe(true);
  });
});
