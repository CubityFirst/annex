import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Check, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface InlineSaveControlsProps {
  changed: boolean;
  saving: boolean;
  onReset: () => void;
  saveDisabled?: boolean;
  resetLabel: string;
  saveLabel: string;
  /** Render the input here (the wrapper is `relative`, so absolutely
   *  positioned adornments like an "@" prefix still work). */
  children: ReactNode;
}

/**
 * An input with inline confirm/cancel controls. While the value matches what
 * is saved the field looks like a plain input; as soon as it differs a pair
 * of icon buttons slides in after it - Cancel (ghost, reverts the draft) and
 * Save (primary, submits the surrounding form) - so an unsaved edit is never
 * ambiguous. Pair with `useSavedFlash` + `SavedIndicator` next to the field
 * label to confirm a successful save.
 */
export function InlineSaveControls({
  changed,
  saving,
  onReset,
  saveDisabled,
  resetLabel,
  saveLabel,
  children,
}: InlineSaveControlsProps) {
  return (
    <div className="flex flex-1 items-start">
      <div className="relative min-w-0 flex-1">{children}</div>
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 overflow-hidden transition-[width,opacity] duration-200 ease-out",
          // ml-2 + two 36px icon buttons + gap-1 (44px buttons below sm).
          changed ? "w-[5.25rem] opacity-100 max-sm:w-[6.25rem]" : "w-0 opacity-0",
        )}
        aria-hidden={!changed}
      >
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="ml-2 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onReset}
          disabled={saving || !changed}
          tabIndex={changed ? 0 : -1}
          aria-label={resetLabel}
          title="Cancel"
        >
          <X className="size-4" />
        </Button>
        <Button
          type="submit"
          size="icon"
          className="shrink-0"
          disabled={saving || !changed || saveDisabled}
          tabIndex={changed ? 0 : -1}
          aria-label={saveLabel}
          title="Save"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

/** `[saved, flash]`: call `flash()` after a successful save; `saved` is true
 *  for `duration` ms (re-flashing restarts the timer). */
export function useSavedFlash(duration = 2000) {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = useCallback(() => {
    clearTimeout(timer.current);
    setSaved(true);
    timer.current = setTimeout(() => setSaved(false), duration);
  }, [duration]);
  return [saved, flash] as const;
}

/** Small muted "✓ Saved" shown next to a field label after a save. The live
 *  region is always mounted so screen readers announce the change. */
export function SavedIndicator({ show, className }: { show: boolean; className?: string }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        // Fixed 16px height even when empty, so the label row never shifts.
        "inline-flex h-4 items-center gap-1 text-xs leading-4 font-normal text-muted-foreground transition-opacity duration-300",
        show ? "opacity-100" : "opacity-0",
        className,
      )}
    >
      {show && (
        <>
          <Check className="size-3" aria-hidden />
          Saved
        </>
      )}
    </span>
  );
}
