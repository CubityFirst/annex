// Mux a sequence of static WebP frames into an animated WebP. Browsers can
// already produce static WebP via canvas.toBlob("image/webp"), but cannot
// build the animation container - that's what this does. Each input frame
// is assumed to cover the full canvas (we place ANMF at offset 0,0 with
// frame_w/h == canvas w/h) and is composited as "do not blend" so the
// previous frame's pixels are fully replaced.
//
// Container reference: https://developers.google.com/speed/webp/docs/riff_container
//
// Layout produced:
//   RIFF........WEBP
//     VP8X (animation flag, canvas size)
//     ANIM (loop count, background colour)
//     ANMF #1 (frame metadata + the static frame's VP8/VP8L/ALPH chunks)
//     ANMF #2
//     ...

export interface WebPFrame {
  /** A complete static WebP file as produced by canvas.toBlob("image/webp"). */
  webp: Uint8Array;
  /** Frame display duration in milliseconds. Capped at 0xFFFFFF (~16777 s). */
  delayMs: number;
}

export function muxAnimatedWebP(
  frames: WebPFrame[],
  width: number,
  height: number,
  loops: number = 0,
): Uint8Array {
  if (frames.length === 0) throw new Error("muxAnimatedWebP: no frames");
  if (width < 1 || height < 1 || width > 0x1000000 || height > 0x1000000) {
    throw new Error("muxAnimatedWebP: invalid dimensions");
  }

  const anmfChunks = frames.map(f => buildAnmf(extractBitstreamChunks(f.webp), width, height, f.delayMs));

  const vp8x = buildVp8x(width, height);
  const anim = buildAnim(loops);

  const bodySize = vp8x.byteLength + anim.byteLength + anmfChunks.reduce((s, c) => s + c.byteLength, 0);
  const totalSize = 12 + bodySize;
  const out = new Uint8Array(totalSize);
  writeAscii(out, 0, "RIFF");
  writeU32LE(out, 4, totalSize - 8);
  writeAscii(out, 8, "WEBP");

  let o = 12;
  out.set(vp8x, o); o += vp8x.byteLength;
  out.set(anim, o); o += anim.byteLength;
  for (const a of anmfChunks) { out.set(a, o); o += a.byteLength; }
  return out;
}

function buildVp8x(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(18);
  writeAscii(buf, 0, "VP8X");
  writeU32LE(buf, 4, 10);
  // Bit 1 of the flag byte = Animation present. Everything else off.
  buf[8] = 0x02;
  writeU24LE(buf, 12, width - 1);
  writeU24LE(buf, 15, height - 1);
  return buf;
}

function buildAnim(loops: number): Uint8Array {
  const buf = new Uint8Array(14);
  writeAscii(buf, 0, "ANIM");
  writeU32LE(buf, 4, 6);
  // Background colour BGRA - left fully transparent; the avatar render
  // ignores corners (clipped to a circle) and the frames themselves have
  // an opaque black fill, so this value is effectively unused.
  buf[8] = buf[9] = buf[10] = buf[11] = 0;
  buf[12] = loops & 0xFF;
  buf[13] = (loops >>> 8) & 0xFF;
  return buf;
}

function buildAnmf(payload: Uint8Array, width: number, height: number, delayMs: number): Uint8Array {
  // ANMF Chunk Size field counts the 16 bytes of frame metadata plus the
  // packed payload chunks. Each payload chunk we pulled in is already RIFF-
  // padded to an even length, so innerSize is always even and the ANMF
  // chunk needs no extra trailing pad byte.
  const innerSize = 16 + payload.byteLength;
  const buf = new Uint8Array(8 + innerSize);
  writeAscii(buf, 0, "ANMF");
  writeU32LE(buf, 4, innerSize);
  writeU24LE(buf, 8, 0);                 // frame X
  writeU24LE(buf, 11, 0);                // frame Y
  writeU24LE(buf, 14, width - 1);
  writeU24LE(buf, 17, height - 1);
  writeU24LE(buf, 20, Math.min(Math.max(0, Math.round(delayMs)), 0xFFFFFF));
  // Flag byte: bit 1 = blending mode (1 = do not blend, just overwrite);
  // bit 0 = disposal (0 = leave canvas alone). Each of our frames already
  // fully overwrites, so "do not blend" + "no dispose" is correct.
  buf[23] = 0x02;
  buf.set(payload, 24);
  return buf;
}

// Walk a static WebP and return the concatenated VP8/VP8L/ALPH chunks.
// Skips RIFF/WEBP header and any file-level VP8X - those belong to the
// outer animated container, not the inner ANMF payload.
function extractBitstreamChunks(webp: Uint8Array): Uint8Array {
  if (webp.length < 12) throw new Error("muxAnimatedWebP: input is not a WebP file");
  if (readAscii(webp, 0, 4) !== "RIFF" || readAscii(webp, 8, 4) !== "WEBP") {
    throw new Error("muxAnimatedWebP: input is not a WebP file");
  }
  let offset = 12;
  const kept: Uint8Array[] = [];
  while (offset + 8 <= webp.length) {
    const cc = readAscii(webp, offset, 4);
    const size = readU32LE(webp, offset + 4);
    const padded = size + (size & 1);
    const chunkEnd = offset + 8 + padded;
    if (chunkEnd > webp.length) break;
    if (cc === "VP8 " || cc === "VP8L" || cc === "ALPH") {
      kept.push(webp.subarray(offset, chunkEnd));
    }
    offset = chunkEnd;
  }
  if (kept.length === 0) throw new Error("muxAnimatedWebP: WebP has no VP8/VP8L bitstream");
  const total = kept.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of kept) { out.set(p, o); o += p.byteLength; }
  return out;
}

function writeU32LE(buf: Uint8Array, offset: number, v: number): void {
  buf[offset] = v & 0xFF;
  buf[offset + 1] = (v >>> 8) & 0xFF;
  buf[offset + 2] = (v >>> 16) & 0xFF;
  buf[offset + 3] = (v >>> 24) & 0xFF;
}

function writeU24LE(buf: Uint8Array, offset: number, v: number): void {
  buf[offset] = v & 0xFF;
  buf[offset + 1] = (v >>> 8) & 0xFF;
  buf[offset + 2] = (v >>> 16) & 0xFF;
}

function readU32LE(buf: Uint8Array, offset: number): number {
  return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
}

function writeAscii(buf: Uint8Array, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) buf[offset + i] = s.charCodeAt(i);
}

function readAscii(buf: Uint8Array, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[offset + i]);
  return s;
}
