import { useState } from "react";
import { AuthenticatedImage } from "@/components/AuthenticatedImage";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { CircleX, ImagePlus, Trash2 } from "lucide-react";

interface Props {
  src: string;
  projectId: string;
  /** Public mode: routes the fetch through /api/public/files so unauthenticated readers can load it. */
  isPublic?: boolean;
  /** Editor-only: open the file picker to replace the current cover. */
  onReplace?: () => void;
  /** Editor-only: clear the cover. */
  onRemove?: () => void;
  busy?: boolean;
}

// Full-bleed banner at the top of the document display panel. Designed to be the
// first child of the padded article column (`flex-1 min-w-0 px-6 py-10`): the
// negative margins cancel that padding so the image spans the full panel width and
// sits flush to the top, then a gradient fades the bottom edge into the page
// background so the title and body below read as a continuation of the image.
// Clicking the image opens a near-fullscreen lightbox.
export function DocCoverImage({ src, projectId, isPublic, onReplace, onRemove, busy }: Props) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const editable = Boolean(onReplace || onRemove);
  return (
    <>
      <div className="group not-prose relative -mx-6 -mt-10 mb-8 h-44 overflow-hidden sm:h-56 md:h-72">
        <AuthenticatedImage
          src={src}
          projectId={projectId}
          isPublic={isPublic}
          alt=""
          onClick={() => setLightboxOpen(true)}
          className="h-full w-full cursor-zoom-in object-cover"
        />
        {/* Fade the bottom edge into the page background. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-background" />
        {editable && (
          <div className="absolute right-3 top-3 flex gap-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            {onReplace && (
              <Button type="button" size="sm" variant="secondary" className="gap-1.5 shadow-sm" onClick={onReplace} disabled={busy}>
                <ImagePlus className="h-3.5 w-3.5" />
                Replace
              </Button>
            )}
            {onRemove && (
              <Button type="button" size="icon" variant="secondary" className="shadow-sm" title="Remove header image" onClick={onRemove} disabled={busy}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        )}
      </div>

      <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <DialogContent hideClose className="w-auto max-w-[95vw] border-0 bg-transparent p-0 shadow-none">
          <DialogTitle className="sr-only">Header image</DialogTitle>
          {/* Click the image (or the backdrop / Esc) to dismiss. */}
          <AuthenticatedImage
            src={src}
            projectId={projectId}
            isPublic={isPublic}
            alt=""
            onClick={() => setLightboxOpen(false)}
            className="max-h-[90vh] w-auto max-w-[95vw] cursor-zoom-out rounded-lg object-contain"
          />
          <DialogClose className="absolute right-2 top-2 rounded-full text-white opacity-80 drop-shadow-[0_1px_3px_rgba(0,0,0,0.7)] transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-white">
            <CircleX className="h-7 w-7" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </DialogContent>
      </Dialog>
    </>
  );
}
