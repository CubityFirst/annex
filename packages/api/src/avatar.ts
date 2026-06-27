// Avatar variant storage + resolution.
//
// Keys in the ASSETS bucket:
//   avatars/{userId}-dark   - dark-background variant (default)
//   avatars/{userId}-light  - light-background variant
//   avatars/{userId}        - legacy pre-variant object; treated as dark and
//                             lazily migrated to -dark on first fetch, then deleted.
//
// The displayed variant is purely client-derived (no DB). If a requested
// variant is missing we fall back to dark so single-variant users never break.

export type AvatarVariant = "dark" | "light";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/** Anything other than the literal "light" resolves to "dark". */
export function parseVariant(raw: string | null | undefined): AvatarVariant {
  return raw === "light" ? "light" : "dark";
}

export function avatarKey(userId: string, variant: AvatarVariant): string {
  return `avatars/${userId}-${variant}`;
}

function legacyKey(userId: string): string {
  return `avatars/${userId}`;
}

export interface ResolvedAvatar {
  body: ArrayBuffer;
  contentType: string;
}

async function getExact(assets: R2Bucket, key: string): Promise<ResolvedAvatar | null> {
  const obj = await assets.get(key);
  if (!obj) return null;
  return { body: await obj.arrayBuffer(), contentType: obj.httpMetadata?.contentType ?? DEFAULT_CONTENT_TYPE };
}

// One-time legacy migration: when a pre-variant avatars/{id} object exists,
// copy it to avatars/{id}-dark, confirm the write, then delete the legacy
// object. Idempotent under concurrent requests (same bytes written, delete is
// a no-op the second time). Returns the migrated bytes, or null if no legacy.
async function migrateLegacy(assets: R2Bucket, userId: string): Promise<ResolvedAvatar | null> {
  const legacy = await assets.get(legacyKey(userId));
  if (!legacy) return null;
  const body = await legacy.arrayBuffer();
  const contentType = legacy.httpMetadata?.contentType ?? DEFAULT_CONTENT_TYPE;
  await assets.put(avatarKey(userId, "dark"), body, { httpMetadata: { contentType } });
  await assets.delete(legacyKey(userId));
  return { body, contentType };
}

/**
 * Resolve the bytes to serve for a user's avatar in the requested variant,
 * with bidirectional fallback so a single-variant user never breaks:
 *   - light: light -> dark -> legacy
 *   - dark:  dark  -> legacy -> light
 * (legacy is migrated to -dark on the way through). Returns null only when the
 * user has no avatar of any kind (caller serves 404).
 */
export async function resolveAvatar(
  assets: R2Bucket,
  userId: string,
  variant: AvatarVariant,
): Promise<ResolvedAvatar | null> {
  if (variant === "light") {
    return (await getExact(assets, avatarKey(userId, "light")))
      ?? (await getExact(assets, avatarKey(userId, "dark")))
      ?? (await migrateLegacy(assets, userId));
  }
  return (await getExact(assets, avatarKey(userId, "dark")))
    ?? (await migrateLegacy(assets, userId))
    ?? (await getExact(assets, avatarKey(userId, "light")));
}

/** Remove every avatar object for a user (both variants + any legacy object). */
export async function deleteAllAvatarVariants(assets: R2Bucket, userId: string): Promise<void> {
  await assets.delete([avatarKey(userId, "dark"), avatarKey(userId, "light"), legacyKey(userId)]);
}
