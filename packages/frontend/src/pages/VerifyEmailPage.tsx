import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { BookOpen } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { setToken } from "@/lib/auth";

export function VerifyEmailPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const token = new URLSearchParams(location.search).get("token");

  const [state, setState] = useState<"loading" | "success" | "failure">(
    token ? "loading" : "failure",
  );
  const [resendEmail, setResendEmail] = useState("");
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  useEffect(() => {
    if (!token) return;

    fetch("/api/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(res => res.json() as Promise<{ ok: boolean; data?: { verified: boolean; token?: string }; error?: string }>)
      .then(json => {
        if (json.ok && json.data?.token) {
          setToken(json.data.token);
          navigate("/dashboard", { replace: true });
          return;
        }
        setState(json.ok ? "success" : "failure");
      })
      .catch(() => setState("failure"));
  }, [token, navigate]);

  async function handleResend() {
    if (!resendEmail.trim()) return;
    setResendState("sending");
    try {
      await fetch("/api/verify-email/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: resendEmail.trim() }),
      });
      setResendState("sent");
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
            <h1 className="text-2xl font-semibold">Email verification</h1>
          </div>

          {state === "loading" && (
            <div className="space-y-3">
              <span role="status" className="sr-only">
                Verifying your email…
              </span>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          )}

          {state === "success" && (
            <>
              <Alert>
                <AlertDescription>
                  Your email has been verified. You can now sign in to your account.
                </AlertDescription>
              </Alert>
              <Button className="w-full" onClick={() => navigate("/login", { replace: true })}>
                Go to sign in
              </Button>
            </>
          )}

          {state === "failure" && (
            <>
              <Alert variant="destructive">
                <AlertDescription>
                  This verification link is invalid or has expired. Request a new one below.
                </AlertDescription>
              </Alert>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="resend-email">Email address</Label>
                  <Input
                    id="resend-email"
                    type="email"
                    placeholder="you@example.com"
                    value={resendEmail}
                    onChange={e => setResendEmail(e.target.value)}
                  />
                </div>
                {resendState === "sent" && (
                  <Alert>
                    <AlertDescription>Verification email sent. Check your inbox.</AlertDescription>
                  </Alert>
                )}
                {resendState === "error" && (
                  <Alert variant="destructive">
                    <AlertDescription>Failed to send email. Please try again.</AlertDescription>
                  </Alert>
                )}
                <Button
                  className="w-full"
                  onClick={handleResend}
                  disabled={resendState === "sending" || resendState === "sent" || !resendEmail.trim()}
                >
                  {resendState === "sending" ? "Sending…" : "Resend verification email"}
                </Button>
                <p className="text-center text-sm text-muted-foreground">
                  <a href="/login" className="text-primary underline-offset-4 hover:underline">
                    Back to sign in
                  </a>
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
