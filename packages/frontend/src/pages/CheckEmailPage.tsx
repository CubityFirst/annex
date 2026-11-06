import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { AuthShell, AUTH_BUTTON_CLASS } from "@/components/AuthForm";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const EMAIL_KEY = "annex:check-email";

function readStoredEmail(): string | undefined {
  try { return sessionStorage.getItem(EMAIL_KEY) ?? undefined; } catch { return undefined; }
}

export function CheckEmailPage() {
  const location = useLocation();
  // Register hands the address over in router state; remember it for the tab
  // so a reload still names it (and keeps the resend button).
  const stateEmail = (location.state as { email?: string } | null)?.email;
  const email = stateEmail ?? readStoredEmail();
  useEffect(() => {
    if (!stateEmail) return;
    try { sessionStorage.setItem(EMAIL_KEY, stateEmail); } catch { /* storage blocked */ }
  }, [stateEmail]);

  const [resendState, setResendState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [cooldown, setCooldown] = useState(false);

  async function handleResend() {
    if (!email || cooldown) return;
    setResendState("sending");
    try {
      await fetch("/api/verify-email/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setResendState("sent");
      setCooldown(true);
      setTimeout(() => setCooldown(false), 30_000);
    } catch {
      setResendState("error");
    }
  }

  return (
    <AuthShell>
        <div className="w-full max-w-sm space-y-6">
          {/* Same heading block as AuthForm's wordmark screens (login,
              register): left-aligned, wordmark then the step as the <h1>. */}
          <div className="flex flex-col items-start gap-2 text-left">
            <a href="/" aria-label="Annex home" className="mb-6 rounded-sm">
              <img src="/annexwordmark.svg" alt="Annex" className="h-7 w-auto dark:invert" />
            </a>
            <h1 className="text-2xl font-semibold tracking-tight">Check your email</h1>
            <p className="text-sm text-muted-foreground">
              {email
                ? <>We sent a link to <strong className="font-medium text-foreground">{email}</strong>.</>
                : "We sent you a verification link."}
              {" "}Click it within 24 hours to activate your account.
            </p>
          </div>

          <div className="rounded-lg border border-border bg-card px-5 py-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Didn&rsquo;t get it?</p>
            <p className="mt-1">
              {email
                ? "Check your spam folder, or send a fresh link below."
                : "Check your spam folder. Signing in with an unverified account also lets you request a fresh link."}
            </p>
          </div>

          {resendState === "sent" && (
            <Alert>
              <AlertDescription>Verification email resent. Check your inbox.</AlertDescription>
            </Alert>
          )}
          {resendState === "error" && (
            <Alert variant="destructive">
              <AlertDescription>Failed to resend email. Please try again.</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-2">
            {email && (
              <Button
                onClick={handleResend}
                disabled={resendState === "sending" || cooldown}
                className={`${AUTH_BUTTON_CLASS} w-full`}
              >
                {resendState === "sending" ? "Sending…" : cooldown ? "Email sent" : "Resend verification email"}
              </Button>
            )}
            <Button asChild variant="ghost" className="-ml-3 h-11 self-start gap-2 px-3 text-muted-foreground hover:text-foreground">
              <a href="/login">
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Back to sign in
              </a>
            </Button>
          </div>
        </div>
    </AuthShell>
  );
}
