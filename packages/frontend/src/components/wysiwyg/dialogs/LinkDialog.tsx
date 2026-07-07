import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

interface LinkDialogProps {
  open: boolean;
  /** Text pre-filled from the editor selection when the dialog opened. */
  initialText: string;
  onClose: () => void;
  onSubmit: (value: { text: string; url: string }) => void;
}

/**
 * "Create link" dialog. The URL input is deliberately `type="text"` (U2):
 * an internal docs tool wants relative links (`/docId`), same-page anchors
 * (`#heading`) and sibling paths (`./page`), all of which `type="url" required`
 * browser validation rejects. Validation is soft - a hint, never a block.
 */
export function LinkDialog({ open, initialText, onClose, onSubmit }: LinkDialogProps) {
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (open) {
      setText(initialText);
      setUrl("");
    }
  }, [open, initialText]);

  const trimmedUrl = url.trim();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmedUrl) return;
    onSubmit({ text: text.trim(), url: trimmedUrl });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Create link</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="link-text">Text</Label>
            <Input
              id="link-text"
              placeholder="Link text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus={initialText.length === 0}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="link-url">URL</Label>
            <Input
              id="link-url"
              type="text"
              placeholder="https://example.com, /doc-id, #heading"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoFocus={initialText.length > 0}
            />
            {trimmedUrl && /\s/.test(trimmedUrl) && (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                This URL contains spaces - it may not work as a link.
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
