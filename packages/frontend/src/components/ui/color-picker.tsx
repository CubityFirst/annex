import { useEffect, useRef, useState } from "react";
import { HexColorPicker } from "react-colorful";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function normalizeHex(value: string): string | null {
  let v = value.trim();
  if (!v.startsWith("#")) v = `#${v}`;
  if (HEX_RE.test(v)) return v.toLowerCase();
  // Allow short form (#rgb) by expanding to long form.
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    const [, r, g, b] = v.match(/^#(.)(.)(.)$/)!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

interface ColorPickerProps {
  value: string;
  onChange: (next: string) => void;
  // Fired when the user has settled on a colour (popover closes, or hex input
  // is committed). Use this for persistence so we don't write on every drag.
  onCommit?: (next: string) => void;
  disabled?: boolean;
  swatchClassName?: string;
}

// shadcn-style HSL canvas + hue slider + hex input, packaged as a popover-
// trigger swatch. Colour is locked to #rrggbb output - anything else gets
// rejected by `normalizeHex`.
export function ColorPicker({ value, onChange, onCommit, disabled, swatchClassName }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const [hexDraft, setHexDraft] = useState(value);
  // Track the colour at popover-open so onCommit only fires when it actually
  // changed across the open/close cycle. Without this, opening then dismissing
  // the picker would re-save the existing value.
  const openValueRef = useRef(value);

  useEffect(() => { setHexDraft(value); }, [value]);

  function handleOpenChange(next: boolean) {
    if (next) openValueRef.current = value;
    setOpen(next);
    if (!next && onCommit) {
      const normalized = normalizeHex(hexDraft);
      const final = normalized ?? value;
      if (final !== openValueRef.current) onCommit(final);
    }
  }

  function commitHexInput() {
    const normalized = normalizeHex(hexDraft);
    if (normalized && normalized !== value) {
      onChange(normalized);
    } else {
      // Roll back the input to the live value if the user typed something
      // that doesn't parse - prevents the field showing an invalid string
      // after blur.
      setHexDraft(value);
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Pick colour"
          className={cn(
            "h-9 w-12 cursor-pointer rounded-md border border-border ring-offset-background transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
            swatchClassName,
          )}
          style={{ backgroundColor: HEX_RE.test(value) ? value : "transparent" }}
        />
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start">
        <div className="color-picker space-y-3">
          <HexColorPicker
            color={HEX_RE.test(value) ? value : "#888888"}
            onChange={onChange}
          />
          <div className="flex items-center gap-2">
            <span aria-hidden className="text-xs text-muted-foreground">#</span>
            <Input
              value={hexDraft.replace(/^#/, "")}
              onChange={(e) => setHexDraft(`#${e.target.value.replace(/^#/, "")}`)}
              onBlur={commitHexInput}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commitHexInput();
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }}
              maxLength={7}
              spellCheck={false}
              className="h-8 font-mono text-xs uppercase"
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
