// Shared role-badge styles, layered on top of <Badge> (whose neutral look
// these match). Roles are information, not status, so they stay neutral (no
// rainbow of hues on the calm palette); Owner only gets slightly brighter text
// and a firmer ring so the top role is findable - still muted, never a
// white-text outline.
const NEUTRAL = "border-transparent bg-muted text-muted-foreground ring-1 ring-inset ring-border";

export const ROLE_BADGE_CLASSES = {
  owner: "border-transparent bg-muted text-foreground/80 ring-1 ring-inset ring-foreground/15",
  admin: NEUTRAL,
  editor: NEUTRAL,
  viewer: NEUTRAL,
  limited: NEUTRAL,
} as const;
