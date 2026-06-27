import { useEffect, useRef, useState } from "react";
import { Play, Pause, FileAudio, Volume2, VolumeX } from "lucide-react";
import { AudioVisualizer } from "@/components/AudioVisualizer";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { apiFetch } from "@/lib/apiFetch";
import type { AudioSize } from "@/lib/audioUrl";
import { cn } from "@/lib/utils";

interface Props {
  src: string;
  alt?: string;
  size?: AudioSize;
  projectId?: string;
  isPublic?: boolean;
  /** Forwarded inline style (width/height/align) - only honored on the full-size container. */
  style?: React.CSSProperties;
  className?: string;
}

// Same docs page AuthenticatedImage links to. Audio inherits the file's
// access rules (published-project read or authenticated member with access),
// so failures resolve to the same explainer.
const PERMISSIONS_DOC_URL =
  "https://docs.cubityfir.st/s/e6d11927-cc6b-48d1-8577-af8b08019d61/258a2eb4-edac-4c86-91aa-afdc46c29c00";

function UnavailableBadge({ alt }: { alt?: string }) {
  return (
    <a href={PERMISSIONS_DOC_URL} target="_blank" rel="noopener noreferrer" aria-label="Audio unavailable - learn more">
      <Badge variant="destructive" className="inline-flex items-center gap-1.5 font-normal cursor-pointer" title={alt}>
        <FileAudio className="h-3.5 w-3.5 shrink-0" />
        Audio unavailable: Learn more about missing files and permissions.
      </Badge>
    </a>
  );
}

// Module-level dedup so concurrent renders of the same audio src share one
// fetch (same trick as AuthenticatedImage). Keeps the first render of a doc
// with several copies of one track from spinning N parallel requests.
const inflight = new Map<string, Promise<Blob | null>>();

function getAudioBlob(src: string): Promise<Blob | null> {
  const existing = inflight.get(src);
  if (existing) return existing;
  const p = apiFetch(src).then(r => (r.ok ? r.blob() : null), () => null);
  inflight.set(src, p);
  p.then(() => setTimeout(() => {
    if (inflight.get(src) === p) inflight.delete(src);
  }, 5_000));
  return p;
}

function resolvePublicSrc(src: string, projectId: string | undefined): string {
  let out = src;
  if (out.startsWith("/api/files/")) out = out.replace("/api/files/", "/api/public/files/");
  if (projectId && !out.includes("projectId=")) {
    out += (out.includes("?") ? "&" : "?") + `projectId=${projectId}`;
  }
  return out;
}

export function AudioEmbed({ src, alt, size = "full", projectId, isPublic, style, className }: Props) {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);

    const isInternal = src?.startsWith("/api/files/") || src?.startsWith("/api/public/files/");
    if (!isInternal) {
      setResolvedSrc(src ?? null);
      return;
    }

    if (isPublic) {
      setResolvedSrc(resolvePublicSrc(src, projectId));
      return;
    }

    let blobUrl: string | null = null;
    let cancelled = false;
    const fetchSrc = projectId ? `${src}?projectId=${projectId}` : src;
    getAudioBlob(fetchSrc).then(blob => {
      if (cancelled) return;
      if (blob) {
        blobUrl = URL.createObjectURL(blob);
        setResolvedSrc(blobUrl);
      } else {
        setFailed(true);
      }
    });
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [src, projectId, isPublic]);

  if (failed) return <UnavailableBadge alt={alt} />;

  if (!resolvedSrc) return null;

  if (size === "small") {
    return <AudioSmall src={resolvedSrc} alt={alt} onError={() => setFailed(true)} className={className} />;
  }
  return <AudioFull src={resolvedSrc} alt={alt} style={style} onError={() => setFailed(true)} className={className} />;
}

// Stops a set of events from bubbling out of an element via NATIVE listeners.
// React's synthetic handlers run after the widget-root's native pointerdown
// listener (and after CM's own click handler), so they're too late to win
// the race - useEffect + addEventListener does. Note: never include "click"
// for an element whose onClick needs to run (React delegates onClick to the
// root container, which the native stop would prevent reaching).
const POINTER_ONLY = ["pointerdown", "mousedown"] as const;
const POINTER_AND_CLICK = ["pointerdown", "mousedown", "click"] as const;

function useStopBubble<T extends HTMLElement>(events: readonly string[] = POINTER_ONLY): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    for (const ev of events) el.addEventListener(ev, stop);
    return () => {
      for (const ev of events) el.removeEventListener(ev, stop);
    };
  }, [events]);
  return ref;
}

function AudioFull({ src, alt, style, onError, className }: { src: string; alt?: string; style?: React.CSSProperties; onError?: () => void; className?: string }) {
  // Native <audio controls> dispatches click events out of its shadow DOM -
  // those need stopping too, otherwise CM's click handler interprets them as
  // "click on the widget area" and reveals.
  const audioRef = useStopBubble<HTMLAudioElement>(POINTER_AND_CLICK);
  return (
    <div className={cn("cm-wysiwyg-audio cm-wysiwyg-audio--full rounded-lg border border-border bg-muted/30 p-4", className)} style={style}>
      <AudioVisualizer audioRef={audioRef} className="mb-3 h-20 text-primary" />
      <audio ref={audioRef} controls src={src} onError={onError} className="w-full" aria-label={alt} />
    </div>
  );
}

function AudioSmall({ src, alt, onError, className }: { src: string; alt?: string; onError?: () => void; className?: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const playButtonRef = useStopBubble<HTMLButtonElement>();
  const volumeButtonRef = useStopBubble<HTMLButtonElement>();
  const trackRef = useRef<HTMLDivElement>(null);

  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [volume, setVolume] = useState(1);
  const [volumeOpen, setVolumeOpen] = useState(false);

  // Hover-based open with a 3s grace window covering BOTH the trigger button
  // and the popover content. Either re-entering cancels the close; leaving
  // both restarts the 3s timer. Generous timer = slack for the user to move
  // mouse from button to slider without flicker.
  const volumeCloseTimerRef = useRef<number | null>(null);
  function cancelVolumeClose() {
    if (volumeCloseTimerRef.current !== null) {
      clearTimeout(volumeCloseTimerRef.current);
      volumeCloseTimerRef.current = null;
    }
  }
  function scheduleVolumeClose() {
    cancelVolumeClose();
    volumeCloseTimerRef.current = window.setTimeout(() => {
      volumeCloseTimerRef.current = null;
      setVolumeOpen(false);
    }, 3000);
  }
  function handleVolumeHoverEnter() {
    cancelVolumeClose();
    setVolumeOpen(true);
  }
  function handleVolumeHoverLeave() {
    scheduleVolumeClose();
  }
  useEffect(() => () => cancelVolumeClose(), []);

  // Sync the playing pill icon with the underlying element state.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, []);

  // Drive the white-fill progress overlay from currentTime. timeupdate fires
  // ~4×/sec during playback which is enough resolution for a 5-bar visual;
  // seeked/loadedmetadata cover the post-scrub jump and initial load.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const update = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setProgress(audio.currentTime / audio.duration);
      } else {
        setProgress(0);
      }
    };
    audio.addEventListener("timeupdate", update);
    audio.addEventListener("seeked", update);
    audio.addEventListener("loadedmetadata", update);
    audio.addEventListener("durationchange", update);
    return () => {
      audio.removeEventListener("timeupdate", update);
      audio.removeEventListener("seeked", update);
      audio.removeEventListener("loadedmetadata", update);
      audio.removeEventListener("durationchange", update);
    };
  }, []);

  // Click-and-drag scrubbing directly on the visualizer. Pointerdown jumps
  // to the click position, drag updates live, release ends. setPointerCapture
  // keeps pointermove flowing even if the cursor leaves the bar mid-drag.
  // Native listeners (not React's) because ReactWidget's pointerdown reveal
  // hook runs before React's synthetic handlers.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let dragging = false;
    let pointerId: number | null = null;

    function applyAt(clientX: number) {
      const rect = track!.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      setProgress(frac);
      const audio = audioRef.current;
      if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = frac * audio.duration;
      }
    }

    function onPointerDown(e: PointerEvent) {
      e.stopPropagation();
      dragging = true;
      pointerId = e.pointerId;
      try { track!.setPointerCapture(e.pointerId); } catch { /* */ }
      applyAt(e.clientX);
    }
    function onPointerMove(e: PointerEvent) {
      if (!dragging) return;
      applyAt(e.clientX);
    }
    function onPointerUp(e: PointerEvent) {
      if (!dragging) return;
      dragging = false;
      if (pointerId !== null) {
        try { track!.releasePointerCapture(pointerId); } catch { /* */ }
        pointerId = null;
      }
      e.stopPropagation();
    }
    function onMouseDown(e: MouseEvent) { e.stopPropagation(); }
    function onClick(e: MouseEvent) { e.stopPropagation(); }

    track.addEventListener("pointerdown", onPointerDown);
    track.addEventListener("pointermove", onPointerMove);
    track.addEventListener("pointerup", onPointerUp);
    track.addEventListener("pointercancel", onPointerUp);
    track.addEventListener("mousedown", onMouseDown);
    track.addEventListener("click", onClick);

    return () => {
      track.removeEventListener("pointerdown", onPointerDown);
      track.removeEventListener("pointermove", onPointerMove);
      track.removeEventListener("pointerup", onPointerUp);
      track.removeEventListener("pointercancel", onPointerUp);
      track.removeEventListener("mousedown", onMouseDown);
      track.removeEventListener("click", onClick);
    };
  }, []);

  function handlePlayClick(e: React.MouseEvent) {
    // stopPropagation prevents CM's click handler from interpreting this as
    // "click moved cursor into widget → reveal."
    e.stopPropagation();
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }

  function handleVolume(values: number[]) {
    const v = Math.max(0, Math.min(1, (values[0] ?? 0) / 100));
    setVolume(v);
    const audio = audioRef.current;
    if (audio) audio.volume = v;
  }

  const muted = volume === 0;
  const clipPct = (1 - progress) * 100;

  return (
    <span
      className={cn(
        "cm-wysiwyg-audio cm-wysiwyg-audio--small inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-1.5 py-[3px] align-middle",
        className,
      )}
    >
      <button
        ref={playButtonRef}
        type="button"
        onClick={handlePlayClick}
        aria-label={playing ? "Pause" : "Play"}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90"
      >
        {playing ? <Pause className="h-2.5 w-2.5" /> : <Play className="h-2.5 w-2.5 translate-x-[0.5px]" />}
      </button>

      <Popover open={volumeOpen} onOpenChange={setVolumeOpen}>
        <PopoverTrigger asChild>
          <button
            ref={volumeButtonRef}
            type="button"
            onClick={(e) => { e.stopPropagation(); }}
            onMouseEnter={handleVolumeHoverEnter}
            onMouseLeave={handleVolumeHoverLeave}
            aria-label={`Volume (${Math.round(volume * 100)}%)`}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
          >
            {muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="center"
          className="flex w-auto items-center justify-center p-2"
          onMouseEnter={handleVolumeHoverEnter}
          onMouseLeave={handleVolumeHoverLeave}
          // Hover-open shouldn't grab focus from whatever the user was doing.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Slider
            orientation="vertical"
            value={[Math.round(volume * 100)]}
            onValueChange={handleVolume}
            min={0}
            max={100}
            step={1}
            // Slider's base styles force data-[orientation=vertical]:h-full
            // and min-h-44 (176px). Override both with the same variant so
            // tailwind-merge replaces them - otherwise the height is ignored.
            className="data-[orientation=vertical]:h-8 data-[orientation=vertical]:min-h-0"
          />
        </PopoverContent>
      </Popover>

      {/* Outer cell contributes h-3 to the pill's flex layout (keeps the chip
          compact); the inner scrub target is absolute and h-7, vertically
          centered, so the waveform protrudes ~3px above/below the pill. */}
      <div className="relative h-3 w-16 shrink-0">
        <div
          ref={trackRef}
          // Acts as the playhead indicator AND the scrub target. Two visualizers
          // are stacked: a grey base, and a white "played" copy clipped from the
          // right so it fills left→right as currentTime advances. clip-path
          // doesn't shrink the canvas's layout - the inner visualizer keeps its
          // full width so bar geometry matches the base exactly.
          className="absolute inset-x-0 top-1/2 h-7 -translate-y-1/2 cursor-pointer"
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <AudioVisualizer
            audioRef={audioRef}
            barCount={20}
            className="absolute inset-0 h-full w-full text-muted-foreground/40"
          />
          <div
            className="pointer-events-none absolute inset-0"
            style={{ clipPath: `inset(0 ${clipPct}% 0 0)` }}
          >
            <AudioVisualizer
              audioRef={audioRef}
              barCount={20}
              className="absolute inset-0 h-full w-full text-foreground"
            />
          </div>
        </div>
      </div>

      {alt ? <span className="max-w-[13ch] truncate text-[10px] text-muted-foreground">{alt}</span> : null}
      <audio ref={audioRef} src={src} preload="metadata" onError={onError} aria-label={alt} />
    </span>
  );
}
