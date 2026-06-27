// Allowed font-choice ids for the reading_font / editing_font columns on
// users. NULL on the row means "use the default" - the frontend treats
// missing values as the default sans stack. Adding a new choice: append
// the id here, add a CSS stack entry in packages/frontend/src/lib/fonts.ts,
// and add a row to the settings matrix in UserSettingsPage.tsx.
export const FONT_CHOICES = ["mono", "sans", "dyslexic"] as const;
export type FontChoice = typeof FONT_CHOICES[number];

export function isFontChoice(value: unknown): value is FontChoice {
  return typeof value === "string" && (FONT_CHOICES as readonly string[]).includes(value);
}
