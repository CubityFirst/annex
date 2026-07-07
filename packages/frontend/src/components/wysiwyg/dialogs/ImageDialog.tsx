import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

interface ImageDialogProps {
  open: boolean;
  /** Alt text pre-filled from the editor selection when the dialog opened. */
  initialAlt: string;
  onClose: () => void;
  onSubmit: (value: { alt: string; url: string }) => void;
}

/**
 * "Insert image" dialog. URL input is `type="text"` (U2) so relative and
 * app-internal image URLs pass; validation is soft - a hint, never a block.
 */
export function ImageDialog({ open, initialAlt, onClose, onSubmit }: ImageDialogProps) {
  const [alt, setAlt] = useState("");
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (open) {
      setAlt(initialAlt);
      setUrl("");
    }
  }, [open, initialAlt]);

  const trimmedUrl = url.trim();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmedUrl) return;
    onSubmit({ alt: alt.trim(), url: trimmedUrl });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Insert image</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="image-alt">Alt text</Label>
            <Input
              id="image-alt"
              placeholder="Image description"
              value={alt}
              onChange={(e) => setAlt(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="image-url">URL</Label>
            <Input
              id="image-url"
              type="text"
              placeholder="https://example.com/image.png"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoFocus
            />
            {trimmedUrl && /\s/.test(trimmedUrl) && (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                This URL contains spaces - it may not work as an image source.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!trimmedUrl}>Insert</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
