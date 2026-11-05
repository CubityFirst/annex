// Shared role-badge styles. Roles are information, not status, so they stay
// neutral (no rainbow of hues on the calm ink palette); only Owner gets a
// slightly stronger, cream-tinted treatment so the top role is findable.
const NEUTRAL = "border-transparent bg-muted text-muted-foreground ring-1 ring-inset ring-border";

export const ROLE_BADGE_CLASSES = {
  owner: "border-transparent bg-foreground/[0.08] text-foreground ring-1 ring-inset ring-foreground/20",
  admin: NEUTRAL,
  editor: NEUTRAL,
  viewer: NEUTRAL,
  limited: NEUTRAL,
} as const;
