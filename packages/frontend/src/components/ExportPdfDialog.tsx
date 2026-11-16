import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { runPdfExport, type PdfPageSize, type PdfTheme } from "@/lib/pdf-export";

interface Props {
  /** Optional trigger; omit and pass `open`/`onOpenChange` to control it from a menu. */
  trigger?: ReactNode;
  documentName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The page shows an AI summary block - otherwise its toggle is a dead control and is hidden. */
  hasAiSummary?: boolean;
  /** The page shows the "Last updated" line - otherwise its toggle is hidden. */
  hasLastUpdated?: boolean;
}

export function ExportPdfDialog({ trigger, documentName, open: controlledOpen, onOpenChange, hasAiSummary = true, hasLastUpdated = true }: Props) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const [pageSize, setPageSize] = useState<PdfPageSize>("A4");
  const [theme, setTheme] = useState<PdfTheme>("light");
  const [includeTitle, setIncludeTitle] = useState(true);
  const [hideAiSummary, setHideAiSummary] = useState(false);
  const [hideLastUpdated, setHideLastUpdated] = useState(false);

  function handleExport() {
    setOpen(false);
    // Let the dialog finish closing before the print pass snapshots the DOM.
    requestAnimationFrame(() => {
      runPdfExport({ pageSize, theme, includeTitle, hideAiSummary, hideLastUpdated, documentName });
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger !== undefined && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-md" onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).focus(); }}>
        <DialogHeader>
          <DialogTitle>Export as PDF</DialogTitle>
          <DialogDescription>
            Opens your browser's print dialog. Choose <strong>Save as PDF</strong> as the destination for a file with selectable text and working links. Margins and scale are set there too.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-6 py-2">
          <div className="flex flex-col gap-4">
            <h3 className="pt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">Layout</h3>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="pdf-page-size" className="text-sm font-medium">Page size</Label>
              <Select value={pageSize} onValueChange={v => setPageSize(v as PdfPageSize)}>
                <SelectTrigger id="pdf-page-size" className="h-8 w-[90px] text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="A3">A3</SelectItem>
                  <SelectItem value="A4">A4</SelectItem>
                  <SelectItem value="A5">A5</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="pdf-theme" className="text-sm font-medium">Theme</Label>
                <p className="text-xs text-muted-foreground">Light is recommended for printing.</p>
              </div>
              <Select value={theme} onValueChange={v => setTheme(v as PdfTheme)}>
                <SelectTrigger id="pdf-theme" className="h-8 w-[90px] text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Separator />
          <div className="flex flex-col gap-4">
            <h3 className="pt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">Include</h3>
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="pdf-include-title" className="text-sm font-medium cursor-pointer">Document name</Label>
                <p className="text-xs text-muted-foreground">The title as a heading at the top of the first page.</p>
              </div>
              <Switch id="pdf-include-title" checked={includeTitle} onCheckedChange={setIncludeTitle} />
            </div>
            {/* Only offer toggles for blocks this page actually shows. */}
            {hasAiSummary && (
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="pdf-hide-ai-summary" className="text-sm font-medium cursor-pointer">AI summary</Label>
                  <p className="text-xs text-muted-foreground">The AI-generated summary block.</p>
                </div>
                {/* Positive phrasing (on = included); state stays "hide" internally. */}
                <Switch id="pdf-hide-ai-summary" checked={!hideAiSummary} onCheckedChange={v => setHideAiSummary(!v)} />
              </div>
            )}
            {hasLastUpdated && (
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="pdf-hide-last-updated" className="text-sm font-medium cursor-pointer">Last updated &amp; reading time</Label>
                  <p className="text-xs text-muted-foreground">The &ldquo;Last updated&hellip; · X min read&rdquo; line.</p>
                </div>
                <Switch id="pdf-hide-last-updated" checked={!hideLastUpdated} onCheckedChange={v => setHideLastUpdated(!v)} />
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleExport}>Export</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
