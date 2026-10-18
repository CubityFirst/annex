import { useCallback, useEffect, useRef } from "react";

// Minimal full-screen fragment-shader runner for the /test/home variants.
// Exposes u_res (device px), u_time (s), u_mouse (0..1, eased, y up) and
// u_dpr. Pauses offscreen / in hidden tabs and renders a single still frame
// under prefers-reduced-motion. Measures the canvas itself, not the window.

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

type FrameHook = (gl: WebGLRenderingContext, prog: WebGLProgram, t: number) => void;

/**
 * `onFrame` runs before every draw so callers can push extra uniforms; the
 * returned `now()` reads the same clock as u_time.
 */
export function useShaderCanvas(frag: string, { maxDpr = 2, onFrame }: { maxDpr?: number; onFrame?: FrameHook } = {}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const start = useRef(performance.now());
  const frameHook = useRef(onFrame);
  frameHook.current = onFrame;
  const now = useCallback(() => (performance.now() - start.current) / 1000, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false });
    if (!gl) return;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error("[test/home] shader:", gl.getShaderInfoLog(s));
      }
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, "precision highp float;\n" + frag));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, "u_res");
    const uTime = gl.getUniformLocation(prog, "u_time");
    const uMouse = gl.getUniformLocation(prog, "u_mouse");
    const uDpr = gl.getUniformLocation(prog, "u_dpr");

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const target = { x: 0.62, y: 0.55 };
    const mouse = { ...target };
    let visible = true;
    let raf = 0;

    const draw = (t: number) => {
      mouse.x += (target.x - mouse.x) * 0.04;
      mouse.y += (target.y - mouse.y) * 0.04;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, t);
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      gl.uniform1f(uDpr, dpr);
      frameHook.current?.(gl, prog, t);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const loop = () => {
      raf = 0;
      if (!visible || document.hidden) return;
      draw(now());
      raf = requestAnimationFrame(loop);
    };
    const kick = () => {
      if (reduced) draw(8);
      else if (!raf) raf = requestAnimationFrame(loop);
    };

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      if (reduced) draw(8);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible) kick();
    });
    io.observe(canvas);

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      target.x = (e.clientX - r.left) / r.width;
      target.y = 1 - (e.clientY - r.top) / r.height;
    };
    const onVis = () => { if (!document.hidden) kick(); };
    if (!reduced) window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("visibilitychange", onVis);
    kick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", onVis);
      // Not loseContext(): a StrictMode remount gets this same (then dead) context back.
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
    };
  }, [frag, maxDpr, now]);

  return { ref, now };
}
