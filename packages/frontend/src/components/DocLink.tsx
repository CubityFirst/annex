import type { ComponentPropsWithoutRef } from "react";
import { Link } from "react-router-dom";

interface DocInfo {
  id: string;
  title: string;
  display_title?: string | null;
  folder_id?: string | null;
}

interface FolderInfo {
  id: string;
  name: string;
  parent_id: string | null;
}

interface MakeDocLinkOptions {
  docs: DocInfo[];
  folders?: FolderInfo[];
  buildUrl: (docId: string, anchor?: string) => string;
}

function buildFolderPaths(folders: FolderInfo[]): Map<string, string> {
  const cache = new Map<string, string>();
  function getPath(id: string): string {
    if (cache.has(id)) return cache.get(id)!;
    const folder = folders.find(f => f.id === id);
    if (!folder) return "";
    const path = folder.parent_id ? getPath(folder.parent_id) + "/" + folder.name : folder.name;
    cache.set(id, path);
    return path;
  }
  for (const f of folders) getPath(f.id);
  return cache;
}

export function resolveDoc(
  rawTitle: string,
  docs: DocInfo[],
  folders: FolderInfo[],
): DocInfo | undefined {
  const trimmed = rawTitle.trim();

  // [[id:UUID]] - direct lookup by document ID
  if (/^id:/i.test(trimmed)) {
    const id = trimmed.slice(3).trim();
    return docs.find(d => d.id === id);
  }

  const segments = trimmed.toLowerCase().split("/").map(s => s.trim());

  const effectiveTitle = (d: DocInfo) => (d.display_title ?? d.title).toLowerCase();

  if (segments.length === 1) {
    return docs.find(d => effectiveTitle(d) === segments[0]);
  }

  // Path match: check if doc's full folder path ends with the written path segments
  const folderPaths = buildFolderPaths(folders);
  return docs.find(doc => {
    const folderPath = doc.folder_id ? (folderPaths.get(doc.folder_id) ?? "") : "";
    const fullPath = folderPath ? folderPath + "/" + (doc.display_title ?? doc.title) : (doc.display_title ?? doc.title);
    const fullSegments = fullPath.toLowerCase().split("/").map(s => s.trim());
    if (segments.length > fullSegments.length) return false;
    const offset = fullSegments.length - segments.length;
    return segments.every((seg, i) => seg === fullSegments[offset + i]);
  });
}

export function makeDocLink({ docs, folders = [], buildUrl }: MakeDocLinkOptions) {
  return function DocLink({
    href,
    children,
    node: _node,
    ...props
  }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
    if (!href?.startsWith("doc://")) {
      return <a href={href} {...props}>{children}</a>;
    }

    const withoutScheme = href.slice("doc://".length);
    const hashIdx = withoutScheme.indexOf("#");
    const encodedTitle = hashIdx === -1 ? withoutScheme : withoutScheme.slice(0, hashIdx);
    const anchor = hashIdx === -1 ? undefined : withoutScheme.slice(hashIdx + 1);
    const rawTitle = decodeURIComponent(encodedTitle);

    const match = resolveDoc(rawTitle, docs, folders);

    if (!match) {
      return (
        <span
          className="line-through text-muted-foreground/60 cursor-not-allowed"
          title={`Document not found: "${rawTitle}"`}
        >
          {children}
        </span>
      );
    }

    return <Link to={buildUrl(match.id, anchor)} {...props}>{children}</Link>;
  };
}
