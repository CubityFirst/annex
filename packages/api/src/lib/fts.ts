import { stripFrontmatter } from "./frontmatter";

function stripMarkdown(content: string): string {
  let text = stripFrontmatter(content);
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/`[^`\n]+`/g, " ");
  text = text.replace(/!\[.*?\]\(.*?\)/g, " ");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/#{1,6}\s+/g, "");
  text = text.replace(/(\*\*|__)(.+?)\1/g, "$2");
  text = text.replace(/(\*|_)(.+?)\1/g, "$2");
  text = text.replace(/^>\s*/gm, "");
  text = text.replace(/^[-*+]\s+/gm, "");
  text = text.replace(/^\d+\.\s+/gm, "");
  text = text.replace(/\|/g, " ");
  text = text.replace(/[~_*[\]]/g, "");
  return text.replace(/\s+/g, " ").trim();
}

export function sanitizeFtsQuery(q: string): string {
  const words = q.replace(/['"*()^:~\-]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '""';
  // Star the final token so search-as-you-type matches partially typed words
  // ("colla" finds "collaboration"); earlier tokens must be complete words.
  return words.map((w, i) => (i === words.length - 1 ? `"${w}"*` : `"${w}"`)).join(" ");
}

export async function upsertFtsRow(
  db: D1Database,
  docId: string,
  projectId: string,
  title: string,
  content: string,
): Promise<void> {
  const body = stripMarkdown(content);
  await db.batch([
    db.prepare("DELETE FROM docs_fts WHERE doc_id = ?").bind(docId),
    db.prepare("INSERT INTO docs_fts(doc_id, project_id, title, body) VALUES (?, ?, ?, ?)")
      .bind(docId, projectId, title, body),
  ]);
}

export async function deleteFtsRow(db: D1Database, docId: string): Promise<void> {
  await db.prepare("DELETE FROM docs_fts WHERE doc_id = ?").bind(docId).run();
}

export async function deleteFtsForProject(db: D1Database, projectId: string): Promise<void> {
  await db.prepare("DELETE FROM docs_fts WHERE project_id = ?").bind(projectId).run();
}
