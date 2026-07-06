import { apiFetch, apiFetchJson } from "@/lib/apiFetch";

// Shared download path for stored files (File Manager rows + FilePage button).
//
// Preferred route: re-fetch the file metadata to mint a *fresh* capability
// token, then navigate an anchor at the tokenized content URL - the browser
// streams the download without this tab buffering the payload, and a token
// minted at click time can never have expired while the page sat open.
// Fallback (no token available, e.g. demo mode): authenticated fetch + Blob.
//
// Returns false when the download could not be started so the caller can toast.
export async function downloadStoredFile(fileId: string, name: string): Promise<boolean> {
  const meta = await apiFetchJson<{ content_token?: string }>(`/api/files/${fileId}`);
  if (meta.redirected) return true; // forced logout - the page is unloading
  if (meta.ok && meta.data?.content_token) {
    triggerAnchorDownload(`/api/files/${fileId}/content?token=${encodeURIComponent(meta.data.content_token)}`, name);
    return true;
  }
  const res = await apiFetch(`/api/files/${fileId}/content`);
  if (!res.ok) return false;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  triggerAnchorDownload(url, name);
  // Deferred revoke: revoking synchronously after click() can abort the
  // download in Safari/Firefox before the browser has opened the blob.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

// Firefox won't reliably start a download from click() on a detached anchor -
// attach it to the document for the click.
function triggerAnchorDownload(href: string, downloadName: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = downloadName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
