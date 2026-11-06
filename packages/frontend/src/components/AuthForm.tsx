import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
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
 * The form block is pinned to a fixed top offset (not vertically centred) so
 * the wordmark sits at the same y on every auth screen - login, register,
 * check-email, verify-email - whatever the height of the form below it.
 * Every screen's block is a `w-full max-w-sm` column starting with the
 * wordmark, so they also share one left edge.
 */
export const AUTH_TOP_CLASS = "pt-16 sm:pt-24 lg:pt-40";

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <div className={`relative flex w-full flex-col items-center justify-start px-6 pb-12 sm:px-10 lg:w-[30rem] lg:max-w-none lg:shrink-0 xl:w-[34rem] ${AUTH_TOP_CLASS}`}>
        {children}
      </div>
      <AuthBrandPanel />
    </div>
  );
}

// Brand panel: the interactive dot field, the product line from the landing
// page and the landing's hero product shot (at ~0.6 scale, fading out), so the
// wide half of the screen carries the brand instead of reading as empty space.
// The block is top-aligned on the same offset as the form, so the eyebrow sits
// level with the wordmark.
export function AuthBrandPanel() {
  return (
      <div className="relative hidden flex-1 overflow-hidden border-l border-border bg-sidebar lg:block" aria-hidden="true">
        <DotGrid />
        <div className="pointer-events-none absolute inset-0 bg-radial-[ellipse_70%_60%_at_45%_50%] from-sidebar via-sidebar/70 to-sidebar/0" />
        <div className={`pointer-events-none absolute inset-0 flex flex-col justify-start px-14 pb-12 xl:px-20 ${AUTH_TOP_CLASS}`}>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">An annex for your mind</p>
          <p className="mt-4 max-w-xl text-5xl font-light leading-[1.05] tracking-[-0.035em] text-foreground">
            A place to keep <span className="font-semibold">anything.</span>
          </p>
          <p className="mt-5 max-w-md text-base leading-relaxed text-muted-foreground">
            Write in markdown, keep files and drawings alongside, and publish any of it to the web when you&rsquo;re ready.
          </p>
          <div className="mt-12 min-h-0 w-full max-w-[42rem] overflow-hidden rounded-lg border border-border shadow-[0_30px_80px_-24px_rgba(0,0,0,0.8)] [mask-image:linear-gradient(to_bottom,#000_50%,transparent_100%)]">
            <img
              src={heroShot}
              alt=""
              width={2304}
              height={1440}
              loading="lazy"
              decoding="async"
              className="block h-auto w-full"
            />
          </div>
        </div>
      </div>
  );
}
