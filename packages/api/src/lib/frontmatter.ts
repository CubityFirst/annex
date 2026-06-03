// NOTE: kept in sync with packages/frontend/src/lib/frontmatter.ts (this file
// has the extra stripFrontmatter helper). When adding a key, update both.
export interface Frontmatter {
  sidebar_position?: number;
  title?: string;
  hide_title?: boolean;
  tags?: string[];
  description?: string;
  image?: string;
  cover?: string;
}

const FM_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

export function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(FM_REGEX);
  if (!match) return {};
  const result: Frontmatter = {};
  const lines = match[1].split(/\r?\n/);
  let collectingTags = false;
  const collectedTags: string[] = [];

  for (const line of lines) {
    if (collectingTags) {
      const tagItem = line.match(/^\s+-\s+(.+)/);
      if (tagItem) {
        const t = tagItem[1].trim().replace(/^['"]|['"]$/g, "").replace(/^#/, "");
        if (t) collectedTags.push(t);
        continue;
      }
      collectingTags = false;
      if (collectedTags.length > 0) result.tags = [...collectedTags];
    }

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();

    if (key === "sidebar_position") {
      const n = Number(val);
      if (!isNaN(n)) result.sidebar_position = n;
    } else if (key === "title") {
      result.title = val.replace(/^['"]|['"]$/g, "");
    } else if (key === "hide_title") {
      result.hide_title = val === "true";
    } else if (key === "tags") {
      if (val.startsWith("[") && val.endsWith("]")) {
        result.tags = val.slice(1, -1).split(",")
          .map(t => t.trim().replace(/^['"]|['"]$/g, "").replace(/^#/, ""))
          .filter(Boolean);
      } else if (val === "") {
        collectingTags = true;
      } else if (val) {
        result.tags = [val.replace(/^['"]|['"]$/g, "").replace(/^#/, "")];
      }
    } else if (key === "description") {
      const stripped = val.replace(/^['"]|['"]$/g, "");
      if (stripped) result.description = stripped;
    } else if (key === "image") {
      const stripped = val.replace(/^['"]|['"]$/g, "");
      if (stripped) result.image = stripped;
    } else if (key === "cover") {
      const stripped = val.replace(/^['"]|['"]$/g, "");
      if (stripped) result.cover = stripped;
    }
  }

  if (collectingTags && collectedTags.length > 0) result.tags = collectedTags;
  return result;
}

export function stripFrontmatter(content: string): string {
  return content.replace(FM_REGEX, "");
}
