import { okResponse, errorResponse, Errors, type Session } from "../lib";
import type { Env } from "../index";
import { resolveAccess } from "../lib/access";

export async function handleAi(
  request: Request,
  env: Env,
  user: Session,
  url: URL,
): Promise<Response> {
  const action = url.pathname.replace(/^\/ai\/?/, "").split("/")[0];

  if (action === "summarize" && request.method === "POST") {
    // Killswitch for the paid, external OpenAI dependency. Checked before any
    // DB/R2 work so a kill takes effect with zero load. Defaults to enabled when
    // the flag/binding is unavailable (local dev or a flag-service outage) - a
    // deliberate-off switch, not fail-closed. The frontend degrades gracefully
    // (it only renders the summary block when a summary is present).
    const aiEnabled = env.FLAGS ? await env.FLAGS.getBooleanValue("ai-summaries", true) : true;
    if (!aiEnabled) {
      return Response.json({ ok: false, error: "ai_disabled", status: 503 }, { status: 503 });
    }

    const body = await request.json<{ docId: string }>();
    if (!body.docId) return errorResponse(Errors.BAD_REQUEST);

    // Fetch the doc + cached summary. Membership is resolved separately via
    // resolveAccess so org trickle-down grants the same access here as on every
    // other per-site route (an org-only member must not be denied summarize).
    // doc_ai_summaries lives in its own table so the docs row stays narrow;
    // LEFT JOIN gives us the cached summary when one exists.
    const doc = await env.DB.prepare(
      `SELECT d.id, d.title, d.project_id, d.updated_at,
              s.summary AS ai_summary, s.version AS ai_summary_version
       FROM docs d
       LEFT JOIN doc_ai_summaries s ON s.doc_id = d.id
       WHERE d.id = ?`,
    ).bind(body.docId).first<{
      id: string;
      title: string;
      project_id: string;
      updated_at: string;
      ai_summary: string | null;
      ai_summary_version: string | null;
    }>();
    if (!doc) return errorResponse(Errors.NOT_FOUND);

    // Effective role on the doc's site (direct OR via the site's org). 404 hides
    // the doc from non-members, mirroring docs.ts.
    const access = await resolveAccess(env.DB, doc.project_id, user.userId);
    if (!access) return errorResponse(Errors.NOT_FOUND);

    // A `limited` member has no project-wide read access - a doc_share is
    // required to read this doc (mirrors the gate in docs.ts). Without this,
    // summarizing would leak the body of any project doc to a limited member.
    if (access.role === "limited") {
      const hasShare = await env.DB.prepare(
        "SELECT id FROM doc_shares WHERE doc_id = ? AND user_id = ? LIMIT 1",
      ).bind(doc.id, user.userId).first();
      if (!hasShare) return errorResponse(Errors.FORBIDDEN);
    }

    // Verify AI is enabled for this project
    const project = await env.DB.prepare("SELECT ai_enabled FROM projects WHERE id = ?")
      .bind(doc.project_id).first<{ ai_enabled: number }>();
    if (!project?.ai_enabled) return errorResponse(Errors.FORBIDDEN);

    // Return cached summary if the doc hasn't changed since it was generated
    if (doc.ai_summary && doc.ai_summary_version === doc.updated_at) {
      return okResponse({ summary: doc.ai_summary });
    }

    // Fetch doc content from R2
    const obj = await env.ASSETS.get(`${doc.project_id}/${doc.id}`);
    const content = obj ? await obj.text() : "";

    if (!content.trim()) {
      return okResponse({ summary: "This document has no content to summarise." });
    }

    // Call OpenAI
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        messages: [
          {
            role: "system",
            content:
              "You are summarizing a documentation page so a reader can decide whether to open it. Write 1–3 short markdown bullets, under 100 words total. Lead with what the doc covers and what someone would do with it.\n\nRules:\n- Don't restate the title (it's shown above the summary).\n- Don't start with \"This document…\", \"Here is a summary\", or similar preambles - go straight to the content.\n- If the doc is a stub or mostly a list/table, say so in one bullet instead of inventing detail.",
          },
          {
            role: "user",
            content: `Title: ${doc.title}\n\n${content.slice(0, 8000)}`,
          },
        ],
        max_completion_tokens: 200,
      }),
    });

    if (!openaiRes.ok) {
      const errBody = await openaiRes.text().catch(() => "(unreadable)");
      console.error(`OpenAI error ${openaiRes.status}: ${errBody}`);
      return errorResponse(Errors.INTERNAL);
    }

    const openaiData = await openaiRes.json<{ choices: { message: { content: string } }[] }>();
    const summary = openaiData.choices?.[0]?.message?.content?.trim() ?? "";

    // Cache the summary against the current doc version
    await env.DB.prepare(
      `INSERT INTO doc_ai_summaries (doc_id, summary, version) VALUES (?, ?, ?)
       ON CONFLICT(doc_id) DO UPDATE SET summary = excluded.summary, version = excluded.version`,
    ).bind(doc.id, summary, doc.updated_at).run();

    return okResponse({ summary });
  }

  return errorResponse(Errors.NOT_FOUND);
}
