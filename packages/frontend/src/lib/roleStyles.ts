// Shared role-badge colours. Tinted text on a faint same-hue wash with an
// inset hairline - legible in both themes without the saturated solid fills
// that made every "Owner" chip shout in dense tables.
export const ROLE_BADGE_CLASSES = {
  owner: "border-transparent bg-violet-500/10 text-violet-700 ring-1 ring-inset ring-violet-500/20 dark:text-violet-300",
  admin: "border-transparent bg-sky-500/10 text-sky-700 ring-1 ring-inset ring-sky-500/20 dark:text-sky-300",
  editor: "border-transparent bg-emerald-500/10 text-emerald-700 ring-1 ring-inset ring-emerald-500/20 dark:text-emerald-300",
  viewer: "border-transparent bg-muted text-muted-foreground ring-1 ring-inset ring-border",
  limited: "border-transparent bg-amber-500/10 text-amber-700 ring-1 ring-inset ring-amber-500/20 dark:text-amber-300",
} as const;
