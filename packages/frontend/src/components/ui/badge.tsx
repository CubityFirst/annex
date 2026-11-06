import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// One pill shape, four looks: neutral (counts, roles, plain labels), success,
// warning and destructive - each a quiet tint with a 1px inset ring, never a
// saturated fill (see .ui-review/DESIGN_SYSTEM.md "Colour discipline"). The
// ring is drawn inset over a transparent border so a call site can still pass
// `border-*` / `ring-*` overrides (e.g. ROLE_BADGE_CLASSES) without the pill
// changing size. `default`, `secondary` and `outline` are kept as names for
// existing call sites and all render as neutral.
const NEUTRAL = "bg-muted text-muted-foreground ring-border";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border border-transparent px-2 py-0.5 text-xs font-medium ring-1 ring-inset transition-colors",
  {
    variants: {
      variant: {
        neutral:     NEUTRAL,
        default:     NEUTRAL,
        secondary:   NEUTRAL,
        outline:     NEUTRAL,
        success:     "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300",
        warning:     "bg-amber-500/10 text-amber-700 ring-amber-500/20 dark:text-amber-300",
        destructive: "bg-destructive/10 text-destructive ring-destructive/25",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
