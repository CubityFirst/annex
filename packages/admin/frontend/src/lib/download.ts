// Save a Blob via a temporary anchor. The anchor must actually be in the
// document (Safari can ignore clicks on detached anchors), and the object
// URL must outlive the click - revoking synchronously can abort the
// download in Safari, so defer it a tick.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
