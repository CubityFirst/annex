import { describe, it, expect } from "vitest";
import { muxAnimatedWebP } from "./webpMux";

// Build a minimal "static WebP" with a synthetic VP8 chunk. We never decode
// the bitstream - the muxer only relocates chunks - so the contents can be
// any bytes as long as the RIFF framing is valid.
function fakeStaticWebP(vp8Payload: Uint8Array): Uint8Array {
  const padded = vp8Payload.byteLength + (vp8Payload.byteLength & 1);
  const total = 12 + 8 + padded;
  const buf = new Uint8Array(total);
  // RIFF + size + WEBP
  buf.set([0x52, 0x49, 0x46, 0x46], 0);
  const fileSize = total - 8;
  buf[4] = fileSize & 0xFF;
  buf[5] = (fileSize >>> 8) & 0xFF;
  buf[6] = (fileSize >>> 16) & 0xFF;
  buf[7] = (fileSize >>> 24) & 0xFF;
  buf.set([0x57, 0x45, 0x42, 0x50], 8);
  // 'VP8 ' chunk (note the trailing space)
  buf.set([0x56, 0x50, 0x38, 0x20], 12);
  buf[16] = vp8Payload.byteLength & 0xFF;
  buf[17] = (vp8Payload.byteLength >>> 8) & 0xFF;
  buf[18] = (vp8Payload.byteLength >>> 16) & 0xFF;
  buf[19] = (vp8Payload.byteLength >>> 24) & 0xFF;
  buf.set(vp8Payload, 20);
  return buf;
}

function ascii(buf: Uint8Array, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[offset + i]);
  return s;
}

function u32(buf: Uint8Array, offset: number): number {
  return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
}

function u24(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16);
}

describe("muxAnimatedWebP", () => {
  it("produces a RIFF/WEBP container with VP8X, ANIM and one ANMF per frame", () => {
    const frame1 = fakeStaticWebP(new Uint8Array([1, 2, 3, 4]));
    const frame2 = fakeStaticWebP(new Uint8Array([5, 6, 7, 8]));
    const out = muxAnimatedWebP(
      [{ webp: frame1, delayMs: 100 }, { webp: frame2, delayMs: 200 }],
      64, 64,
    );

    expect(ascii(out, 0, 4)).toBe("RIFF");
    expect(u32(out, 4)).toBe(out.byteLength - 8);
    expect(ascii(out, 8, 4)).toBe("WEBP");
    expect(ascii(out, 12, 4)).toBe("VP8X");
    expect(u32(out, 16)).toBe(10);
    // Animation flag bit (bit 1) set, nothing else.
    expect(out[20]).toBe(0x02);
    // Canvas width/height minus one (uint24 LE)
    expect(u24(out, 24)).toBe(63);
    expect(u24(out, 27)).toBe(63);

    expect(ascii(out, 30, 4)).toBe("ANIM");
    expect(u32(out, 34)).toBe(6);
    // Loop count default 0 (infinite)
    expect(out[42] | (out[43] << 8)).toBe(0);

    expect(ascii(out, 44, 4)).toBe("ANMF");
  });

  it("preserves per-frame delay in the ANMF duration field", () => {
    const f = fakeStaticWebP(new Uint8Array([9, 9, 9, 9]));
    const out = muxAnimatedWebP([{ webp: f, delayMs: 150 }], 32, 32);
    // First ANMF starts at: RIFF(12) + VP8X(18) + ANIM(14) = 44
    expect(ascii(out, 44, 4)).toBe("ANMF");
    // ANMF duration field is at offset 8 from ANMF start + 12 = 20 bytes in
    expect(u24(out, 44 + 8 + 12)).toBe(150);
  });

  it("embeds the source VP8 chunk verbatim inside the ANMF payload", () => {
    const payload = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]);
    const frame = fakeStaticWebP(payload);
    const out = muxAnimatedWebP([{ webp: frame, delayMs: 100 }], 16, 16);
    // ANMF at offset 44; ANMF inner payload starts at 44 + 8 + 16 = 68
    // The inner payload should be the 8-byte VP8 chunk header + 4-byte payload = 12 bytes
    expect(ascii(out, 68, 4)).toBe("VP8 ");
    expect(u32(out, 72)).toBe(4);
    expect(Array.from(out.slice(76, 80))).toEqual([0xAA, 0xBB, 0xCC, 0xDD]);
  });

  it("handles odd-sized VP8 chunks with the RIFF pad byte", () => {
    const payload = new Uint8Array([0x11, 0x22, 0x33]); // 3 bytes → 1 byte pad
    const frame = fakeStaticWebP(payload);
    const out = muxAnimatedWebP([{ webp: frame, delayMs: 100 }], 16, 16);
    // ANMF inner payload contains the VP8 chunk header (8) + payload (3) + pad (1) = 12 bytes
    expect(ascii(out, 68, 4)).toBe("VP8 ");
    expect(u32(out, 72)).toBe(3);
    expect(Array.from(out.slice(76, 79))).toEqual([0x11, 0x22, 0x33]);
    expect(out[79]).toBe(0); // pad byte
  });

  it("rejects empty frame arrays", () => {
    expect(() => muxAnimatedWebP([], 64, 64)).toThrow(/no frames/);
  });

  it("rejects invalid dimensions", () => {
    const f = fakeStaticWebP(new Uint8Array([0]));
    expect(() => muxAnimatedWebP([{ webp: f, delayMs: 100 }], 0, 64)).toThrow(/dimensions/);
  });

  it("rejects input that is not a WebP", () => {
    const notWebP = new Uint8Array(20);
    expect(() => muxAnimatedWebP([{ webp: notWebP, delayMs: 100 }], 16, 16)).toThrow(/not a WebP/);
  });

  it("clamps oversized delays to the 24-bit field", () => {
    const f = fakeStaticWebP(new Uint8Array([0]));
    const out = muxAnimatedWebP([{ webp: f, delayMs: 99_999_999 }], 16, 16);
    expect(u24(out, 44 + 8 + 12)).toBe(0xFFFFFF);
  });
});
