import { useImperativeHandle, useRef, type Ref } from "react";
import { useShaderCanvas } from "./useShaderCanvas";

// Domain-warped fbm "smoke" in phosphor green under heavy animated film
// grain. Callers can `puff()` ink into it at a client coordinate (the hero
// does this per keystroke from the caret): each puff rises, widens and
// thins out over ~7s, folded into the same warp as the ambient smoke.

const MAX_PUFFS = 12;
const PUFF_LIFE = 7;

const FRAG = `
uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_mouse;
uniform float u_ambient;
uniform vec4 u_puffs[${MAX_PUFFS}];

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 6; i++) { v += a * noise(p); p = rot * p * 2.02 + 3.1; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / u_res.y;
  vec2 s = vec2(uv.x * aspect, uv.y);
  vec2 p = s * 1.15;
  float t = u_time * 0.045;

  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3 - t)));
  vec2 r = vec2(fbm(p + 3.0 * q + vec2(1.7 + t, 9.2)), fbm(p + 3.0 * q + vec2(8.3, 2.8 - t)));
  float f = fbm(p + 3.0 * r);

  // Ink puffs: shredded by a fine warp so they tear into wisps, not blobs.
  vec2 hw = vec2(fbm(s * 7.0 + t * 3.0), fbm(s * 7.0 + 5.0 - t * 3.0)) - 0.5;
  float ink = 0.0;
  for (int i = 0; i < ${MAX_PUFFS}; i++) {
    vec4 pf = u_puffs[i];
    float age = u_time - pf.z;
    if (pf.w <= 0.0 || age < 0.0 || age > ${PUFF_LIFE.toFixed(1)}) continue;
    vec2 c = vec2(pf.x * aspect, pf.y) + vec2(0.03 * sin(age * 0.9 + pf.z), 0.05 * age);
    float rad = 0.018 + 0.03 * age;
    vec2 d = s - c + hw * rad * 2.4 + (r - 0.5) * 0.08 * age;
    float puff = exp(-dot(d, d) / (rad * rad));
    float life = smoothstep(0.0, 0.2, age) * (1.0 - smoothstep(1.0, ${PUFF_LIFE.toFixed(1)}, age));
    ink += puff * life * pf.w * (0.3 + 1.6 * max(hw.x + hw.y, 0.0));
  }
  float inkT = 1.0 - exp(-ink * 1.3);

  // Mostly dark: a faint body of smoke, thin bright filaments only where
  // the warped field peaks, and a hot core near the pointer.
  float body = pow(smoothstep(0.42, 0.95, f), 1.8) * u_ambient;
  float wisps = pow(smoothstep(0.6, 0.95, f * (0.75 + 0.5 * length(r - 0.5))), 3.0) * u_ambient;
  vec2 m = vec2(u_mouse.x * aspect, u_mouse.y);
  float near = exp(-3.0 * length(s - m));

  vec3 bg = vec3(0.004, 0.03, 0.022);
  vec3 mid = vec3(0.05, 0.36, 0.24);
  vec3 hot = vec3(0.6, 1.0, 0.82);
  vec3 col = bg + mid * body * 0.55;
  col += mid * wisps * 0.9;
  col += hot * pow(wisps, 2.0) * (0.25 + near * 1.2);
  col += mid * inkT * 1.3 + hot * pow(inkT, 3.0) * 0.7;
  // Keep the left (copy side) calmer.
  col *= 0.5 + 0.5 * smoothstep(0.05, 0.7, uv.x);

  float vig = smoothstep(1.25, 0.25, length((uv - 0.5) * vec2(aspect, 1.0)));
  col *= 0.35 + 0.65 * vig;

  // Grain re-rolled ~24 times a second so it shimmers rather than crawls.
  float frame = floor(u_time * 24.0);
  float g = hash(gl_FragCoord.xy + frame * 17.13) - 0.5;
  col += g * (0.11 + 0.12 * dot(col, vec3(0.33)));
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

export type SmokeHandle = {
  /** Release a puff of ink at a viewport (client) coordinate. */
  puff: (clientX: number, clientY: number, strength?: number) => void;
};

type Props = {
  className?: string;
  /** Strength of the ambient smoke (0..1); puffs are unaffected. */
  ambient?: number;
  handle?: Ref<SmokeHandle>;
};

export function GrainSmoke({ className, ambient = 1, handle }: Props) {
  const puffs = useRef(new Float32Array(MAX_PUFFS * 4));
  const next = useRef(0);
  const { ref, now } = useShaderCanvas(FRAG, {
    onFrame: (gl, prog) => {
      gl.uniform1f(gl.getUniformLocation(prog, "u_ambient"), ambient);
      gl.uniform4fv(gl.getUniformLocation(prog, "u_puffs"), puffs.current);
    },
  });

  useImperativeHandle(handle, () => ({
    puff: (clientX, clientY, strength = 1) => {
      const c = ref.current;
      if (!c) return;
      const r = c.getBoundingClientRect();
      const i = next.current++ % MAX_PUFFS;
      puffs.current.set([(clientX - r.left) / r.width, 1 - (clientY - r.top) / r.height, now(), strength], i * 4);
    },
  }), [ref, now]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
