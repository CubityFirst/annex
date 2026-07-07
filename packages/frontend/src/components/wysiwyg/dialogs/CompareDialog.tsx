import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { Check, Loader2, Upload } from "lucide-react";

interface CompareDialogProps {
  open: boolean;
  onClose: () => void;
  /** Receives the finished ```juxtapose fenced block (no surrounding newlines). */
  onSubmit: (block: string) => void;
  /** When provided, each image gets an Upload button that resolves to a URL. */
  onUploadImage?: (file: File) => Promise<{ url: string }>;
}

/** "Insert image comparison" dialog - builds a ```juxtapose fenced block. */
export function CompareDialog({ open, onClose, onSubmit, onUploadImage }: CompareDialogProps) {
  const [before, setBefore] = useState("");
  const [after, setAfter] = useState("");
  const [beforeLabel, setBeforeLabel] = useState("");
  const [afterLabel, setAfterLabel] = useState("");
  const [orientation, setOrientation] = useState<"horizontal" | "vertical">("horizontal");
  const [handle, setHandle] = useState<"arrows" | "bar">("arrows");
  const [colorMode, setColorMode] = useState<"default" | "accent" | "custom">("default");
  const [customColor, setCustomColor] = useState("#3b82f6");
  const [uploading, setUploading] = useState<null | "before" | "after">(null);
  const beforeFileRef = useRef<HTMLInputElement>(null);
  const afterFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setBefore("");
      setAfter("");
      setBeforeLabel("");
      setAfterLabel("");
      setOrientation("horizontal");
      setHandle("arrows");
      setColorMode("default");
      setCustomColor("#3b82f6");
      setUploading(null);
    }
  }, [open]);

  const handleUpload = async (which: "before" | "after", file: File) => {
    if (!onUploadImage) return;
    setUploading(which);
    try {
      const { url } = await onUploadImage(file);
      if (which === "before") setBefore(url);
      else setAfter(url);
    } catch {
      // onUploadImage surfaces upload failures via toast.
    } finally {
      setUploading(null);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const b = before.trim();
    const a = after.trim();
    if (!b || !a) return;
    const bLabel = beforeLabel.trim();
    const aLabel = afterLabel.trim();
    const lines = ["```juxtapose"];
    lines.push(`before: ${b}${bLabel ? ` "${bLabel}"` : ""}`);
    lines.push(`after: ${a}${aLabel ? ` "${aLabel}"` : ""}`);
    if (orientation === "vertical") lines.push("orientation: vertical");
    if (handle === "bar") lines.push("handle: bar");
    if (colorMode === "accent") lines.push("accent: theme");
    else if (colorMode === "custom") lines.push(`accent: ${customColor.trim()}`);
    lines.push("```");
    onSubmit(lines.join("\n"));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Insert image comparison</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {(["before", "after"] as const).map((which) => {
            const url = which === "before" ? before : after;
            const setUrl = which === "before" ? setBefore : setAfter;
            const label = which === "before" ? beforeLabel : afterLabel;
            const setLabel = which === "before" ? setBeforeLabel : setAfterLabel;
            const fileRef = which === "before" ? beforeFileRef : afterFileRef;
            const isUploading = uploading === which;
            return (
              <div key={which} className="flex flex-col gap-2 rounded-md border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium capitalize">{which} image</span>
                  {url && <Check className="h-4 w-4 text-green-600" aria-label="Image set" />}
                </div>
                <div className="flex gap-2">
                  <Input
                    aria-label={`${which} image URL`}
                    placeholder="Image URL"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                  {onUploadImage && (
                    <>
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleUpload(which, file);
                          e.target.value = "";
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={isUploading}
                        onClick={() => fileRef.current?.click()}
                      >
                        {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                        Upload
                      </Button>
                    </>
                  )}
                </div>
                <Input
                  aria-label={`${which} label`}
                  placeholder="Label (optional)"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
            );
          })}
          <div className="flex flex-col gap-1.5">
            <Label>Orientation</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={orientation === "horizontal" ? "default" : "outline"}
                className="flex-1"
                onClick={() => setOrientation("horizontal")}
              >
                Horizontal
              </Button>
              <Button
                type="button"
                variant={orientation === "vertical" ? "default" : "outline"}
                className="flex-1"
                onClick={() => setOrientation("vertical")}
              >
                Vertical
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Handle style</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={handle === "arrows" ? "default" : "outline"}
                className="flex-1"
                onClick={() => setHandle("arrows")}
              >
                Circle + arrows
              </Button>
              <Button
                type="button"
                variant={handle === "bar" ? "default" : "outline"}
                className="flex-1"
                onClick={() => setHandle("bar")}
              >
                Slim grip bar
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Handle colour</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant={colorMode === "default" ? "default" : "outline"}
                onClick={() => setColorMode("default")}
              >
                Default
              </Button>
              <Button
                type="button"
                variant={colorMode === "accent" ? "default" : "outline"}
                onClick={() => setColorMode("accent")}
              >
                Theme accent
              </Button>
              <Button
                type="button"
                variant={colorMode === "custom" ? "default" : "outline"}
                onClick={() => setColorMode("custom")}
              >
                Custom
              </Button>
              {colorMode === "custom" && <ColorPicker value={customColor} onChange={setCustomColor} />}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!before.trim() || !after.trim() || uploading !== null}>Insert</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
