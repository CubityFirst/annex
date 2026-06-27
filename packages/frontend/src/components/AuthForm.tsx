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
    <div className="flex min-h-screen bg-background text-foreground">
      <div className="relative flex w-full max-w-md flex-col items-center justify-center px-6 sm:px-10">
        <div className="w-full max-w-sm space-y-6">
          <div className="flex flex-col items-center gap-2 text-center">
            {wordmark ?? (
              <>
                <BookOpen className="h-8 w-8 text-primary" />
                <h1 className="text-2xl font-semibold">{title}</h1>
              </>
            )}
            <p className="text-sm text-muted-foreground mt-2">{subtitle}</p>
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
        {devPanel && (
          <div className="absolute bottom-4 left-10 right-10">
            {devPanel}
          </div>
        )}
      </div>

      <div className="relative hidden flex-1 lg:block" aria-hidden="true">
        <DotGrid />
      </div>
    </div>
  );
}
