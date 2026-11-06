import { useState } from "react";
import { BookOpen, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DotGrid } from "@/components/DotGrid";
import heroShot from "@/assets/landing/write.webp";

/**
 * Text fields on the auth screens: 44px tall (comfortable touch target, and
 * level with the 44px submit) with a resting outline that clears 3:1 against
 * the page (the shared Input's hairline is too faint for a first-run form).
 */
export const AUTH_INPUT_CLASS = "h-11 border-foreground/50 dark:border-foreground/40";

/** Full-width action buttons on the auth screens - same height as the fields. */
export const AUTH_BUTTON_CLASS = "h-11";

/**
 * Auth-screen password field with a show/hide toggle inside its right edge.
 * The toggle's name comes from sr-only text, NOT aria-label: Playwright's
 * getByLabel("Password") substring-matches aria-label too, so an
 * aria-label="Show password" button would make every e2e login ambiguous.
 */
export function PasswordInput({ className, id, ...props }: Omit<React.ComponentProps<typeof Input>, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        {...props}
        id={id}
        type={visible ? "text" : "password"}
        // ::-ms-reveal: drop Edge's built-in eye so there aren't two.
        className={cn(AUTH_INPUT_CLASS, "pr-12 sm:pr-10 [&::-ms-reveal]:hidden", className)}
      />
      <button
        type="button"
        onClick={() => setVisible(v => !v)}
        aria-pressed={visible}
        aria-controls={id}
        className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 sm:right-1.5 sm:h-8 sm:w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {visible ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
        <span className="sr-only">{visible ? "Hide password" : "Show password"}</span>
      </button>
    </div>
  );
}

interface AuthFormProps {
  title: string;
  subtitle: string;
  submitLabel: string;
  loading?: boolean;
  disabled?: boolean;
  error?: string | null;
  onSubmit: (e: React.FormEvent) => void;
  children: React.ReactNode;
  footer: React.ReactNode;
  hideSubmit?: boolean;
  wordmark?: React.ReactNode;
  // Optional informational banner rendered above the form, e.g. "you've been
  // signed out because your account was disabled." Distinct from `error`,
  // which uses destructive styling for action failures.
  header?: React.ReactNode;
  devPanel?: React.ReactNode;
}

export function AuthForm({
  title,
  subtitle,
  submitLabel,
  loading,
  disabled,
  error,
  onSubmit,
  children,
  footer,
  hideSubmit,
  wordmark,
  header,
  devPanel,
}: AuthFormProps) {
  return (
    <AuthShell>
        <div className="w-full max-w-sm space-y-6">
          {/* Heading block left-aligned to the form edge, so the wordmark,
              title, labels and fields share one left rule. */}
          <div className="flex flex-col items-start gap-2 text-left">
            {wordmark ? (
              // Wordmark screens: a compact brand mark (links home) and the
              // step itself ("Sign in to your account") as the visible <h1>,
              // so the form column reads as a form, not a logo with fields.
              <>
                <a href="/" aria-label="Annex home" className="mb-6 rounded-sm">
                  {wordmark}
                </a>
                <h1 className="text-2xl font-semibold tracking-tight">{subtitle}</h1>
              </>
            ) : (
              <>
                <BookOpen className="h-8 w-8 text-primary" aria-hidden="true" />
                <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
                <p className="text-sm text-muted-foreground">{subtitle}</p>
              </>
            )}
          </div>

          {header}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <form onSubmit={onSubmit} className="space-y-4">
            {children}
            {!hideSubmit && (
              <Button type="submit" className={`${AUTH_BUTTON_CLASS} w-full`} disabled={loading || disabled}>
                {loading ? `${submitLabel}…` : submitLabel}
              </Button>
            )}
          </form>

          {footer && <p className="text-sm text-muted-foreground">{footer}</p>}

          {/* Dev builds only: quick-login shortcuts, framed as a labelled
              panel on the form's own 384px column. */}
          {devPanel && (
            <section aria-label="Dev quick login" className="rounded-lg border border-dashed border-border p-4">
              <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
                Dev quick login
              </p>
              {devPanel}
            </section>
          )}
        </div>
    </AuthShell>
  );
}

/**
 * Split auth layout: form rail on the left, brand panel on wide screens.
 * On wide screens the form block is vertically centred in its column (and the
 * brand panel's content in its own), so a short step like register or
 * check-email doesn't sit high with the bottom half of the column empty.
 * Phones/tablets keep a fixed top offset, so the form starts near the top and
 * stays put when the on-screen keyboard opens. Every screen's block is a
 * `w-full max-w-sm` column starting with the wordmark, so they share one
 * left edge.
 */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <div className="relative flex w-full flex-col items-center justify-start px-6 pb-12 pt-16 sm:px-10 sm:pt-24 lg:w-[30rem] lg:max-w-none lg:shrink-0 lg:justify-center lg:py-16 xl:w-[34rem]">
        {children}
      </div>
      <AuthBrandPanel />
    </div>
  );
}

// Brand panel: the interactive dot field, the product line from the landing
// page and the landing's hero product shot, so the wide half of the screen
// carries the brand instead of reading as empty space. The headline block sits
// at a fixed share of the viewport height (level with the top of the centred
// form); the shot below it is drawn near real size (~0.8x, so its UI text
// stays legible) and bleeds off the panel's right and bottom edges, which the
// panel's overflow-hidden crops - so it shows the sidebar, the doc title and
// the callout instead of a shrunken full-window thumbnail.
export function AuthBrandPanel() {
  return (
      <div className="relative hidden flex-1 overflow-hidden border-l border-border bg-sidebar lg:block" aria-hidden="true">
        <DotGrid />
        <div className="pointer-events-none absolute inset-0 bg-radial-[ellipse_70%_60%_at_45%_50%] from-sidebar via-sidebar/70 to-sidebar/0" />
        <div className="pointer-events-none absolute inset-0 flex flex-col pl-14 pt-[clamp(4rem,18vh,11rem)] xl:pl-20">
          <div className="max-w-xl pr-14 xl:pr-20">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">An annex for your mind</p>
            <p className="mt-4 text-5xl font-light leading-[1.05] tracking-[-0.035em] text-foreground">
              A place to keep <span className="font-semibold">anything.</span>
            </p>
            <p className="mt-5 max-w-md text-base leading-relaxed text-muted-foreground">
              Write in markdown, keep files and drawings alongside and publish any of it to the web when you&rsquo;re ready.
            </p>
          </div>
          {/* Fixed width (the capture is 1152 CSS px wide at 1x, so 54rem /
              57rem is ~0.75x / ~0.8x) and left-anchored: the panel crops the
              right and bottom. The frame grows to the panel's bottom edge,
              capped at the image's own height on tall screens, and ONE mask on
              the frame (border included) fades it out before that edge. */}
          <div className="mt-12 flex min-h-[10rem] w-[54rem] max-w-none flex-1 shrink-0 self-start overflow-hidden rounded-tl-lg border-l border-t border-border max-h-[33.75rem] shadow-[0_30px_80px_-24px_rgba(0,0,0,0.8)] [-webkit-mask-image:linear-gradient(to_bottom,#000_60%,transparent),linear-gradient(to_right,#000_calc(100%_-_20rem),transparent_calc(100%_-_6rem))] [-webkit-mask-composite:source-in] [mask-image:linear-gradient(to_bottom,#000_60%,transparent),linear-gradient(to_right,#000_calc(100%_-_20rem),transparent_calc(100%_-_6rem))] [mask-composite:intersect] xl:w-[57rem] xl:max-h-[35.625rem]">
            <img
              src={heroShot}
              alt=""
              width={2304}
              height={1440}
              loading="lazy"
              decoding="async"
              className="block h-auto w-full max-w-none self-start"
            />
          </div>
        </div>
      </div>
  );
}
