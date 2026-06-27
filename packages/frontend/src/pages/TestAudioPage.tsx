import { useRef, useState } from "react";
import { AudioVisualizer } from "@/components/AudioVisualizer";
import { Button } from "@/components/ui/button";

const SOURCES = {
  warframe: {
    label: "Warframe",
    url: "https://i.cubityfir.st/WARFRAME%20%26%20Matthew%20Chalmers%20-%20Roses%20from%20the%20Abyss.flac",
  },
  funny: {
    label: "Funny",
    url: "https://i.cubityfir.st/a%20funny.flac",
  },
  spoken: {
    label: "Spoken Word",
    url: "https://i.cubityfir.st/to-ensure-optimal-performance-.wav",
  },
} as const;

type SourceKey = keyof typeof SOURCES;

export function TestAudioPage() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [selected, setSelected] = useState<SourceKey>("warframe");

  // Swap the audio element's src without remounting it - the MediaElementSource
  // wiring inside AudioVisualizer is keyed to the element, and the visualizer's
  // tuning state lives inside the component, so neither resets on source change.
  function pick(key: SourceKey) {
    if (key === selected) return;
    const audio = audioRef.current;
    const wasPlaying = audio ? !audio.paused : false;
    setSelected(key);
    if (wasPlaying && audio) {
      // Wait for the new src to be applied + briefly loaded before resuming.
      const onCanPlay = () => {
        audio.removeEventListener("canplay", onCanPlay);
        audio.play().catch(() => {});
      };
      audio.addEventListener("canplay", onCanPlay);
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex flex-wrap gap-2">
        {(Object.keys(SOURCES) as SourceKey[]).map((key) => (
          <Button
            key={key}
            variant={selected === key ? "default" : "outline"}
            onClick={() => pick(key)}
          >
            {SOURCES[key].label}
          </Button>
        ))}
      </div>
      <div className="rounded-lg border border-border bg-muted/30 p-4">
        <AudioVisualizer audioRef={audioRef} className="mb-3 h-20 text-primary" showControls />
        <audio
          ref={audioRef}
          controls
          src={SOURCES[selected].url}
          crossOrigin="anonymous"
          className="w-full"
        />
      </div>
    </div>
  );
}
