import { useShaderCanvas } from "./useShaderCanvas";

// Ordered (Bayer 8x8) dither of a slow domain-warped noise field, quantised
// to a 4-tone blue ramp on a visible pixel grid. A soft light trails the
// pointer. Matches the "dither" panel of the reference.

const PIXEL = 3; // css px per dither cell

const FRAG = `
uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_mouse;
uniform float u_dpr;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.0; a *= 0.5; }
  return v;
}
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

void main() {
  float px = ${PIXEL.toFixed(1)} * u_dpr;
  vec2 cell = floor(gl_FragCoord.xy / px);
  vec2 uv = (cell * px) / u_res;
  float aspect = u_res.x / u_res.y;
  vec2 p = vec2(uv.x * aspect, uv.y) * 2.2;
  float t = u_time * 0.06;

  vec2 q = vec2(fbm(p + t), fbm(p + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + t * 1.4), fbm(p + 3.0 * q + vec2(8.3, 2.8)));
  float f = fbm(p + 3.5 * r);
  f = smoothstep(0.25, 0.85, f);

  vec2 m = vec2(u_mouse.x * aspect, u_mouse.y);
  float light = exp(-2.2 * length(vec2(uv.x * aspect, uv.y) - m));
  float l = f * (0.35 + 1.05 * light) + 0.25 * light;
  l *= smoothstep(0.0, 0.25, uv.y) * 0.4 + 0.6;

  float levels = 3.0;
  float v = floor(clamp(l, 0.0, 1.0) * levels + bayer8(cell)) / levels;

  vec3 c0 = vec3(0.004, 0.012, 0.06);
  vec3 c1 = vec3(0.02, 0.07, 0.42);
  vec3 c2 = vec3(0.10, 0.27, 0.96);
  vec3 c3 = vec3(0.47, 0.64, 1.0);
  vec3 col = v < 0.17 ? c0 : v < 0.5 ? c1 : v < 0.84 ? c2 : c3;

  // Faint gutter between cells so the grid reads as pixels, not blur.
  vec2 g = fract(gl_FragCoord.xy / px);
  float gap = step(0.78, max(g.x, g.y)) * step(1.5, px);
  col = mix(col, c0, gap * 0.55);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function DitherField({ className }: { className?: string }) {
  const { ref } = useShaderCanvas(FRAG);
  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
