import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface AudioVisualizerProps extends Omit<React.HTMLAttributes<HTMLCanvasElement>, "color"> {
  /** Ref to the <audio> element whose output will drive the visualization. */
  audioRef: React.RefObject<HTMLAudioElement | null>;
  /** Number of bars to render. Default 140. */
  barCount?: number;
  /** Smoothing 0–1, higher = smoother but slower decay. Default 0.8. */
  smoothing?: number;
  /** FFT size, must be a power of 2 in [32, 32768]. Default 4096. */
  fftSize?: number;
  /** Fraction of FFT bins to sample, top-down trimmed. Default 0.8. */
  maxBinRatio?: number;
  /** Power-curve exponent for distance→bin mapping. Higher = more bars in the
   *  low-frequency center. Default 1.3. */
  lowEndBias?: number;
  /** When true, low frequencies are at the center and expand symmetrically to
   *  both edges. When false, freqs run linearly low→high, left→right. Default true. */
  mirror?: boolean;
  /** TEMPORARY: render tuning sliders below the canvas. */
  showControls?: boolean;
  /** Tailwind class controls bar color via `currentColor` - defaults to text-primary. */
  className?: string;
}

// MediaElementSource can only be created once per <audio> element per page.
// Cache the wiring keyed by element so re-mounts of the visualizer can re-attach
// without throwing "HTMLMediaElement already connected" from createMediaElementSource.
type Wiring = {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  analyser: AnalyserNode;
};
const wiringByElement = new WeakMap<HTMLAudioElement, Wiring>();

function getOrCreateWiring(audio: HTMLAudioElement, fftSize: number, smoothing: number): Wiring | null {
  const cached = wiringByElement.get(audio);
  if (cached) {
    cached.analyser.fftSize = fftSize;
    cached.analyser.smoothingTimeConstant = smoothing;
    return cached;
  }
  const Ctx: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  try {
    const ctx = new Ctx();
    const source = ctx.createMediaElementSource(audio);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = smoothing;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    const wiring = { ctx, source, analyser };
    wiringByElement.set(audio, wiring);
    return wiring;
  } catch {
    return null;
  }
}

export function AudioVisualizer({
  audioRef,
  barCount: barCountProp = 140,
  smoothing: smoothingProp = 0.8,
  fftSize: fftSizeProp = 4096,
  maxBinRatio: maxBinRatioProp = 0.8,
  lowEndBias: lowEndBiasProp = 1.3,
  mirror: mirrorProp = true,
  showControls = false,
  className,
  ...rest
}: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Local tunable state - initialized from props, mutable via the temporary
  // sliders. Effect reads these directly, not the props.
  const [barCount, setBarCount] = useState(barCountProp);
  const [smoothing, setSmoothing] = useState(smoothingProp);
  const [fftSize, setFftSize] = useState(fftSizeProp);
  const [maxBinRatio, setMaxBinRatio] = useState(maxBinRatioProp);
  const [lowEndBias, setLowEndBias] = useState(lowEndBiasProp);
  const [mirror, setMirror] = useState(mirrorProp);

  useEffect(() => {
    const audio = audioRef.current;
    const canvas = canvasRef.current;
    if (!audio || !canvas) return;

    let raf: number | null = null;
    let cachedColor = "currentColor";
    let dataArray: Uint8Array<ArrayBuffer> | null = null;
    let fadeData: Uint8Array<ArrayBuffer> | null = null;
    let fadeStart: number | null = null;
    const FADE_MS = 350;

    function refreshColor() {
      if (!canvas) return;
      const c = getComputedStyle(canvas).color;
      if (c) cachedColor = c;
    }

    function syncSize(): { w: number; h: number } {
      if (!canvas) return { w: 0, h: 0 };
      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const targetH = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== targetW) canvas.width = targetW;
      if (canvas.height !== targetH) canvas.height = targetH;
      return { w: canvas.width, h: canvas.height };
    }

    function paintFlat() {
      if (!canvas) return;
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return;
      const { w, h } = syncSize();
      ctx2d.clearRect(0, 0, w, h);
      ctx2d.fillStyle = cachedColor;
      const dpr = window.devicePixelRatio || 1;
      const gap = Math.max(1, Math.floor(dpr));
      const barWidth = Math.max(1, (w - gap * (barCount - 1)) / barCount);
      const midY = h / 2;
      const lineH = Math.max(1, Math.floor(dpr));
      for (let i = 0; i < barCount; i++) {
        const x = i * (barWidth + gap);
        ctx2d.fillRect(x, midY - lineH / 2, barWidth, lineH);
      }
    }

    function paintBars(source: Uint8Array<ArrayBuffer>, scale: number) {
      if (!canvas) return;
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return;
      const { w, h } = syncSize();
      ctx2d.clearRect(0, 0, w, h);
      ctx2d.fillStyle = cachedColor;

      const dpr = window.devicePixelRatio || 1;
      const gap = Math.max(1, Math.floor(dpr));
      const barWidth = Math.max(1, (w - gap * (barCount - 1)) / barCount);
      const midY = h / 2;
      const halfMax = (h / 2) * 0.95;
      const radius = Math.min(barWidth / 2, 3 * dpr);
      const useRound = typeof ctx2d.roundRect === "function";

      // Drop the upper portion of the spectrum (where music has near-zero
      // energy) and concentrate sampling on the lower bins. The power scale
      // then biases bars further toward the very low end.
      const bins = source.length;
      const usableBins = Math.max(1, Math.floor(bins * Math.min(1, Math.max(0.05, maxBinRatio))));
      // Walk distance buckets (in mirror mode: from center outward; otherwise
      // from leftmost bar rightward) and assign each one a frequency bin via
      // the power curve, with a strict monotonic step so successive bars never
      // share a bin (avoids a fused lockstep blob at the low end).
      const center = (barCount - 1) / 2;
      const stepCount = mirror ? Math.ceil(barCount / 2) : barCount;
      const maxDist = mirror ? Math.max(1, center) : Math.max(1, barCount - 1);
      const distOffset = mirror && barCount % 2 === 0 ? 0.5 : 0;
      const binByStep = new Int32Array(stepCount);
      let prevIdx = -1;
      for (let d = 0; d < stepCount; d++) {
        const t = (d + distOffset) / maxDist;
        const raw = Math.floor(Math.pow(t, lowEndBias) * usableBins);
        const next = Math.min(usableBins - 1, Math.max(raw, prevIdx + 1));
        binByStep[d] = next;
        prevIdx = next;
      }

      for (let i = 0; i < barCount; i++) {
        const d = mirror
          ? Math.min(stepCount - 1, Math.floor(Math.abs(i - center)))
          : i;
        const idx = binByStep[d];
        const amp = (source[idx] / 255) * scale;
        const halfBarH = Math.max(0.5, amp * halfMax);
        const x = i * (barWidth + gap);
        const y = midY - halfBarH;
        const barH = halfBarH * 2;
        ctx2d.beginPath();
        if (useRound) {
          ctx2d.roundRect(x, y, barWidth, barH, radius);
        } else {
          ctx2d.rect(x, y, barWidth, barH);
        }
        ctx2d.fill();
      }
    }

    function draw() {
      const wiring = wiringByElement.get(audio!);
      if (!wiring || !canvas) {
        raf = null;
        return;
      }
      const analyser = wiring.analyser;
      const bins = analyser.frequencyBinCount;
      if (!dataArray || dataArray.length !== bins) {
        dataArray = new Uint8Array(new ArrayBuffer(bins));
      }
      analyser.getByteFrequencyData(dataArray);
      paintBars(dataArray, 1);
      raf = requestAnimationFrame(draw);
    }

    function fadeStep() {
      if (!canvas || fadeStart === null || !fadeData) {
        raf = null;
        return;
      }
      const elapsed = performance.now() - fadeStart;
      const t = Math.min(1, elapsed / FADE_MS);
      // Ease-out quad - fast initial collapse, soft landing at zero.
      const scale = 1 - t * t;
      paintBars(fadeData, scale);
      if (t < 1) {
        raf = requestAnimationFrame(fadeStep);
      } else {
        fadeData = null;
        fadeStart = null;
        raf = null;
        paintFlat();
      }
    }

    function start() {
      if (!audio) return;
      const wiring = getOrCreateWiring(audio, fftSize, smoothing);
      if (!wiring) return;
      if (wiring.ctx.state === "suspended") {
        wiring.ctx.resume().catch(() => {});
      }
      refreshColor();
      // Cancel any in-progress fade and resume live draw.
      fadeData = null;
      fadeStart = null;
      if (raf !== null) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    }

    function stop() {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      // If we have a recent snapshot, fade it inward; otherwise just flatten.
      if (dataArray && dataArray.length > 0) {
        fadeData = new Uint8Array(dataArray);
        fadeStart = performance.now();
        raf = requestAnimationFrame(fadeStep);
      } else {
        paintFlat();
      }
    }

    refreshColor();
    paintFlat();

    audio.addEventListener("play", start);
    audio.addEventListener("pause", stop);
    audio.addEventListener("ended", stop);

    const ro = "ResizeObserver" in window ? new ResizeObserver(() => {
      if (raf === null) paintFlat();
    }) : null;
    ro?.observe(canvas);

    if (!audio.paused) start();

    return () => {
      audio.removeEventListener("play", start);
      audio.removeEventListener("pause", stop);
      audio.removeEventListener("ended", stop);
      ro?.disconnect();
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      // Intentionally do NOT close the AudioContext or disconnect the source -
      // the wiring is keyed to the <audio> element and reused across remounts;
      // tearing it down would silence the audio if the parent re-renders.
    };
  }, [audioRef, barCount, smoothing, fftSize, maxBinRatio, lowEndBias, mirror]);

  return (
    <div>
      <canvas
        ref={canvasRef}
        className={cn("block h-16 w-full text-primary", className)}
        {...rest}
      />
      {showControls && (
        <TuningControls
          barCount={barCount} setBarCount={setBarCount}
          smoothing={smoothing} setSmoothing={setSmoothing}
          fftSize={fftSize} setFftSize={setFftSize}
          maxBinRatio={maxBinRatio} setMaxBinRatio={setMaxBinRatio}
          lowEndBias={lowEndBias} setLowEndBias={setLowEndBias}
          mirror={mirror} setMirror={setMirror}
        />
      )}
    </div>
  );
}

// TEMPORARY: tuning UI for live-tweaking visualizer parameters. Remove this
// component (and the `showControls` prop) once values are dialed in.
interface TuningControlsProps {
  barCount: number; setBarCount: (n: number) => void;
  smoothing: number; setSmoothing: (n: number) => void;
  fftSize: number; setFftSize: (n: number) => void;
  maxBinRatio: number; setMaxBinRatio: (n: number) => void;
  lowEndBias: number; setLowEndBias: (n: number) => void;
  mirror: boolean; setMirror: (b: boolean) => void;
}

function TuningControls(p: TuningControlsProps) {
  const fftOptions = [256, 512, 1024, 2048, 4096];
  const [status, setStatus] = useState<string | null>(null);

  function flash(msg: string) {
    setStatus(msg);
    window.setTimeout(() => setStatus(null), 1800);
  }

  async function handleExport() {
    const payload = {
      barCount: p.barCount,
      smoothing: p.smoothing,
      fftSize: p.fftSize,
      maxBinRatio: p.maxBinRatio,
      lowEndBias: p.lowEndBias,
      mirror: p.mirror,
    };
    const json = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      flash("Copied!");
    } catch {
      window.prompt("Copy these values:", json);
    }
  }

  async function handleImport() {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      const fallback = window.prompt("Paste exported values here:");
      if (fallback == null) return;
      text = fallback;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      flash("Invalid JSON");
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      flash("Invalid format");
      return;
    }
    const v = parsed as Record<string, unknown>;
    if (typeof v.barCount === "number") p.setBarCount(v.barCount);
    if (typeof v.smoothing === "number") p.setSmoothing(v.smoothing);
    if (typeof v.fftSize === "number" && fftOptions.includes(v.fftSize)) p.setFftSize(v.fftSize);
    if (typeof v.maxBinRatio === "number") p.setMaxBinRatio(v.maxBinRatio);
    if (typeof v.lowEndBias === "number") p.setLowEndBias(v.lowEndBias);
    if (typeof v.mirror === "boolean") p.setMirror(v.mirror);
    flash("Applied!");
  }

  return (
    <div className="mt-3 grid grid-cols-1 gap-2 rounded-md border border-dashed border-border bg-muted/40 p-3 text-xs sm:grid-cols-2">
      <Slider label="barCount" value={p.barCount} min={16} max={256} step={2} onChange={p.setBarCount} />
      <Slider label="smoothing" value={p.smoothing} min={0} max={0.99} step={0.01} onChange={p.setSmoothing} fixed={2} />
      <Slider label="maxBinRatio" value={p.maxBinRatio} min={0.05} max={1} step={0.01} onChange={p.setMaxBinRatio} fixed={2} />
      <Slider label="lowEndBias" value={p.lowEndBias} min={0.5} max={4} step={0.05} onChange={p.setLowEndBias} fixed={2} />
      <label className="flex items-center justify-between gap-2">
        <span className="font-mono text-muted-foreground">fftSize</span>
        {/* Exception to the shadcn-only rule: native <select> is intentional here.
            This is the dev-only tuning panel (showControls, never set in the real
            app - see TEMPORARY note below) and is slated for removal, so it isn't
            worth a shadcn Select. */}
        <select
          value={p.fftSize}
          onChange={e => p.setFftSize(Number(e.target.value))}
          className="rounded border border-border bg-background px-2 py-1 font-mono"
        >
          {fftOptions.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="font-mono text-muted-foreground">mirror</span>
        <input
          type="checkbox"
          checked={p.mirror}
          onChange={e => p.setMirror(e.target.checked)}
          className="h-4 w-4 accent-primary"
        />
      </label>
      <div className="flex items-center gap-2 sm:col-span-2">
        <button
          type="button"
          onClick={handleExport}
          className="rounded border border-border bg-background px-2 py-1 font-mono text-xs hover:bg-accent"
        >
          Export
        </button>
        <button
          type="button"
          onClick={handleImport}
          className="rounded border border-border bg-background px-2 py-1 font-mono text-xs hover:bg-accent"
        >
          Import
        </button>
        {status && <span className="font-mono text-xs text-muted-foreground">{status}</span>}
      </div>
    </div>
  );
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fixed?: number;
  onChange: (n: number) => void;
}

function Slider({ label, value, min, max, step, fixed, onChange }: SliderProps) {
  const display = fixed != null ? value.toFixed(fixed) : String(value);
  return (
    <label className="flex items-center gap-2">
      <span className="w-24 shrink-0 font-mono text-muted-foreground">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="flex-1 accent-primary"
      />
      <span className="w-12 shrink-0 text-right font-mono tabular-nums">{display}</span>
    </label>
  );
}
