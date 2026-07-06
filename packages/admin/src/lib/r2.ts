// Deletes every R2 object under `prefix`, in batches. One list() page is at
// most 1000 keys and the array form of delete() accepts up to 1000 keys, so
// each page maps to exactly one delete subrequest - a project with thousands
// of doc/revision objects stays far below the Workers subrequest limit (a
// one-delete-per-D1-row fan-out does not). Listing by prefix (rather than by
// surviving D1 rows) also sweeps up objects orphaned by a failed insert.
// Mirrors packages/api/src/lib/docOps.ts deleteR2Prefix, which sits in a
// module that drags in the API worker's whole import graph - hence the local
// copy instead of a cross-package import.
export async function deleteR2Prefix(assets: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listing = await assets.list({ prefix, cursor });
    if (listing.objects.length > 0) {
      await assets.delete(listing.objects.map(o => o.key));
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor !== undefined);
}
