import { useEffect, useRef } from "react";

const SPACING = 24;
const RADIUS = 1;

/**
 * Quiet, uniform dot field behind the auth brand panel. Every dot is the same
 * size and colour - an earlier cursor-driven size ramp left a cluster of large,
 * bright dots wherever the pointer last rested (often hugging the panel edge),
 * which read as a rendering glitch rather than a deliberate effect. Static, so
 * it redraws only on resize or a theme switch instead of every frame.
 */
export function DotGrid() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas!.offsetWidth;
      const h = canvas!.offsetHeight;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, w, h);
      ctx!.fillStyle = getComputedStyle(document.documentElement)
        .getPropertyValue("--border")
        .trim() || "oklch(0.92 0.004 286.32)";
      const cols = Math.ceil(w / SPACING) + 1;
      const rows = Math.ceil(h / SPACING) + 1;
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          ctx!.beginPath();
          ctx!.arc(c * SPACING, r * SPACING, RADIUS, 0, Math.PI * 2);
          ctx!.fill();
        }
      }
    }

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    // The dot colour comes from the --border token - repaint on theme switch.
    const mo = new MutationObserver(draw);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });

    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />;
}
