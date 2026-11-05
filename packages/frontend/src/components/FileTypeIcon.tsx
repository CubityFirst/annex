import { Image, Music, Video, FileCode, FileArchive, FileText, File, PenTool } from "lucide-react";
import { fileKind } from "@/lib/fileKind";

/**
 * Icon for a stored file, chosen from its kind (see lib/fileKind). Shared by the
 * file listing, the file viewer, and the public site so the mapping can't drift.
 * Pass `name` alongside `mimeType` so extension-based detection works for files
 * the browser mis-typed (e.g. a `.ts` source arriving as video/mp2t).
 * Decorative - the file's name always sits beside it - so hidden from AT.
 */
export function FileTypeIcon({ mimeType, name, className }: { mimeType: string; name?: string; className?: string }) {
  const props = { className, "aria-hidden": true } as const;
  switch (fileKind(mimeType, name)) {
    case "image": return <Image {...props} />;
    case "audio": return <Music {...props} />;
    case "video": return <Video {...props} />;
    case "pdf": return <FileText {...props} />;
    case "drawing": return <PenTool {...props} />;
    case "text": return <FileCode {...props} />;
    case "archive": return <FileArchive {...props} />;
    default: return <File {...props} />;
  }
}
