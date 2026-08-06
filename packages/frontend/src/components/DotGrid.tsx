import { useEffect, useRef } from "react";

const SPACING = 24;
const BASE_RADIUS = 1;
const MAX_RADIUS = 6;
const INFLUENCE_RADIUS = 120;

export function DotGrid() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);
  const animFrameRef = useRef<number>(0);
  // current animated radius for each dot: [col][row]
  const radiiRef = useRef<Float32Array | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d")!;
    let cols = 0;
    let rows = 0;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas!.width = canvas!.offsetWidth * dpr;
      canvas!.height = canvas!.offsetHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(canvas!.offsetWidth / SPACING) + 1;
      rows = Math.ceil(canvas!.offsetHeight / SPACING) + 1;
      radiiRef.current = new Float32Array(cols * rows).fill(BASE_RADIUS);
    }

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    function draw() {
      animFrameRef.current = requestAnimationFrame(draw);
      if (!radiiRef.current) return;

      const w = canvas!.offsetWidth;
      const h = canvas!.offsetHeight;
      ctx.clearRect(0, 0, w, h);

      const mouse = mouseRef.current;
      const radii = radiiRef.current;
      const color = getComputedStyle(document.documentElement)
        .getPropertyValue("--border")
        .trim() || "oklch(0.92 0.004 286.32)";

      ctx.fillStyle = color;

      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          const x = c * SPACING;
          const y = r * SPACING;
          const idx = c * rows + r;

          let target = BASE_RADIUS;
          if (mouse) {
            const dx = x - mouse.x;
            const dy = y - mouse.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < INFLUENCE_RADIUS) {
              const t = 1 - dist / INFLUENCE_RADIUS;
              target = BASE_RADIUS + (MAX_RADIUS - BASE_RADIUS) * t * t;
            }
          }

          // lerp toward target
          radii[idx] += (target - radii[idx]) * 0.15;

          ctx.beginPath();
          ctx.arc(x, y, radii[idx], 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    draw();

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      ro.disconnect();
    };
  }, []);

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function handleMouseLeave() {
    mouseRef.current = null;
  }

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    />
  );
}
