import { useState } from "react";
import { useLocation } from "react-router-dom";
import { Mail } from "lucide-react";
import { AuthShell } from "@/components/AuthForm";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function CheckEmailPage() {
  const location = useLocation();
  const email = (location.state as { email?: string } | null)?.email;

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
          <div className="flex flex-col items-center gap-3 text-center">
            <a href="/" aria-label="Annex home" className="mb-4"><img src="/annexwordmark.svg" alt="Annex" className="h-7 w-auto dark:invert" /></a>
            <span className="flex size-12 items-center justify-center rounded-full border border-border bg-card">
              <Mail className="size-5 text-foreground" aria-hidden="true" />
            </span>
            <h1 className="text-2xl font-semibold tracking-tight">Check your email</h1>
            <p className="text-sm text-muted-foreground">
              {email
                ? <>We sent a verification link to <strong>{email}</strong>.</>
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

          <div className="flex flex-col gap-3">
            {email && (
              <Button
                onClick={handleResend}
                disabled={resendState === "sending" || cooldown}
                className="w-full"
              >
                {resendState === "sending" ? "Sending…" : cooldown ? "Email sent" : "Resend verification email"}
              </Button>
            )}
            <a
              href="/login"
              className="text-center text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
            >
              Back to sign in
            </a>
          </div>
        </div>
    </AuthShell>
  );
}
