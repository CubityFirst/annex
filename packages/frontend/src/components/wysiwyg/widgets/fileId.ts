// The body of a ```file / ```excalidraw fence is interpolated into an
// authenticated API URL path. Restricting it to the id alphabet stops a
// crafted fence body (e.g. `../projects`) from steering the victim's browser
// into an arbitrary same-origin API GET whose response fields would render
// into the card. Real file ids are UUID-ish (hex + dashes); allow the
// conservative URL-safe set.
const FILE_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isSafeFileId(id: string): boolean {
  return FILE_ID_RE.test(id);
}
