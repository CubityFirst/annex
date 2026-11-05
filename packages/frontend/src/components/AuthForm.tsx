import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DotGrid } from "@/components/DotGrid";

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
    <AuthShell aside={devPanel && (
      <div className="absolute bottom-4 left-6 right-6 sm:left-10 sm:right-10">
        {devPanel}
      </div>
    )}>
        <div className="w-full max-w-sm space-y-6">
          <div className="flex flex-col items-center gap-2 text-center">
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
              <Button type="submit" className="w-full" disabled={loading || disabled}>
                {loading ? `${submitLabel}…` : submitLabel}
              </Button>
            )}
          </form>

          <p className="text-center text-sm text-muted-foreground">{footer}</p>
        </div>
    </AuthShell>
  );
}

/** Split auth layout: form rail on the left, brand panel on wide screens. */
export function AuthShell({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <div className="relative flex w-full flex-col items-center justify-center px-6 py-12 sm:px-10 lg:w-[30rem] lg:max-w-none lg:shrink-0 xl:w-[34rem]">
        {children}
        {aside}
      </div>
      <AuthBrandPanel />
    </div>
  );
}

// Brand panel: the interactive dot field plus the product line from the
// landing page, so the wide half of the screen carries the brand instead of
// reading as empty space.
export function AuthBrandPanel() {
  return (
      <div className="relative hidden flex-1 overflow-hidden border-l border-border bg-sidebar lg:block" aria-hidden="true">
        <DotGrid />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-sidebar via-sidebar/40 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 px-14 pb-[clamp(4rem,14vh,9rem)]">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">An annex for your mind</p>
          <p className="mt-4 max-w-xl text-5xl font-light leading-[1.05] tracking-[-0.035em] text-foreground">
            A place to keep <span className="font-semibold">anything.</span>
          </p>
          <p className="mt-5 max-w-md text-base leading-relaxed text-muted-foreground">
            Write in markdown, keep files and drawings alongside, and publish any of it to the web when you&rsquo;re ready.
          </p>
        </div>
      </div>
  );
}
