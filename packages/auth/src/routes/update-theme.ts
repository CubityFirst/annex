import { requireAuthenticatedSession } from "../auth-session";
import { okResponse, errorResponse, Errors } from "../lib";
import { isThemeMode, isHexColor } from "../theme";
import type { Env } from "../index";

// Sets the user's site theme (dark / light / custom). Available to any
// authenticated user - callers are responsible for Flagship flag gating.
//
// `customColor` is only persisted for the 'custom' mode; any other mode nulls
// it so a stale colour doesn't linger and re-apply if the user flips back to
// custom later. Both columns are written every time (single radio on the UI),
// so no partial-column upsert juggling like update-reading-font.
export async function handleUpdateTheme(request: Request, env: Env): Promise<Response> {
  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  const body = await request.json<{ theme?: unknown; customColor?: unknown }>();

  if (!isThemeMode(body.theme)) return errorResponse(Errors.BAD_REQUEST);

  let customColor: string | null = null;
  if (body.theme === "custom") {
    if (!isHexColor(body.customColor)) return errorResponse(Errors.BAD_REQUEST);
    customColor = body.customColor.toLowerCase();
  }

  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, theme_mode, theme_custom_color) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET theme_mode = excluded.theme_mode, theme_custom_color = excluded.theme_custom_color`,
  ).bind(session.userId, body.theme, customColor).run();

  return okResponse({ theme: body.theme, customColor });
}
