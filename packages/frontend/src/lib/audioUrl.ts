// Detect whether a URL points at an audio file, so the same ![](…) markdown
// syntax can dispatch to either an <img> renderer or an audio embed renderer.

const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"]);

export function isAudioUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const clean = url.split("?")[0]!.split("#")[0]!;
  const m = clean.match(/\.([a-z0-9]+)$/i);
  return !!m && AUDIO_EXTS.has(m[1]!.toLowerCase());
}

// Internal file URLs (`/api/files/:id/content`) carry the mime type only at
// request time - the path has no extension. Copy-markdown fills the alt with
// the original filename, so we fall back to the alt extension when the URL
// has no extension of its own. URLs that already have an extension are
// trusted (we don't promote `photo.png` to audio because someone wrote
// "song.mp3" as the alt text).
export function looksLikeAudio(url: string | undefined | null, alt?: string | undefined | null): boolean {
  if (isAudioUrl(url)) return true;
  if (hasExtension(url)) return false;
  return isAudioUrl(alt);
}

function hasExtension(url: string | undefined | null): boolean {
  if (!url) return false;
  const clean = url.split("?")[0]!.split("#")[0]!;
  return /\.[a-z0-9]+$/i.test(clean);
}

export type AudioSize = "full" | "small";

export function parseAudioSize(value: string | undefined | null): AudioSize {
  return value === "small" ? "small" : "full";
}
