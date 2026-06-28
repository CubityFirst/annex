import { useState } from "react";
import { useLocation } from "react-router-dom";
import { BookOpen, Mail } from "lucide-react";
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
    <div className="flex min-h-screen bg-background text-foreground">
      <div className="flex w-full max-w-md flex-col items-center justify-center px-10">
        <div className="w-full max-w-sm space-y-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <BookOpen className="h-8 w-8 text-primary" aria-hidden="true" />
            <h1 className="text-2xl font-semibold">Check your email</h1>
            <p className="text-sm text-muted-foreground">
              {email
                ? <>We sent a verification link to <strong>{email}</strong>.</>
                : "We sent you a verification link."}
              {" "}Click it within 24 hours to activate your account.
            </p>
          </div>

          <div className="flex flex-col items-center gap-1 rounded-lg border p-6">
            <Mail className="h-10 w-10 text-muted-foreground mb-2" aria-hidden="true" />
            <p className="text-sm text-muted-foreground text-center">
              Didn't receive the email? Check your spam folder, or request a new link.
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
                variant="outline"
                className="w-full"
              >
                {resendState === "sending" ? "Sending…" : cooldown ? "Email sent" : "Resend verification email"}
              </Button>
            )}
            <a
              href="/login"
              className="text-center text-sm text-primary underline-offset-4 hover:underline"
            >
              Back to sign in
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
