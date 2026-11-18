// Allowed theme modes for the theme_mode column on user_preferences. NULL on
// the row means "use the default" (dark) - the frontend treats a missing /
// unknown value as dark. 'custom' additionally stores a #rrggbb base in
// theme_custom_color, from which the frontend derives the full palette.
//
// Setting the theme is gated (admins, or the custom-theming flag) in the
// PATCH /me/theme route in src/index.ts. Keep this list in sync with
// THEME_MODES in packages/frontend/src/lib/theme.ts.
export const THEME_MODES = ["dark", "light", "custom"] as const;
export type ThemeMode = typeof THEME_MODES[number];

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}
