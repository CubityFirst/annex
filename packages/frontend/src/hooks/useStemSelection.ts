import { useCallback, useRef } from "react";
import { focusNameStem } from "@/lib/fileManager";

/**
 * Rename dialogs for files: open with only the name - not the extension -
 * selected (see focusNameStem). Spread `inputProps` on the input and pass
 * `onOpenAutoFocus` to the DialogContent.
 *
 * A menu that opened the dialog hands focus back to its trigger as it
 * finishes closing, and the dialog's focus trap returns it to the input with
 * the whole value selected. So until the user types or clicks in the field,
 * any such return re-selects the stem.
 */
export function useStemSelection(enabled: boolean) {
  const ref = useRef<HTMLInputElement>(null);
  const armed = useRef(false);
  const onOpenAutoFocus = useCallback((e: Event) => {
    armed.current = enabled;
    if (!enabled) return;
    e.preventDefault();
    focusNameStem(ref.current);
  }, [enabled]);
  const disarm = useCallback(() => { armed.current = false; }, []);
  const onFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    if (!armed.current) return;
    const el = e.currentTarget;
    requestAnimationFrame(() => {
      if (armed.current && document.activeElement === el) focusNameStem(el);
    });
  }, []);
  return { onOpenAutoFocus, inputProps: { ref, onFocus, onPointerDown: disarm, onKeyDown: disarm } };
}
