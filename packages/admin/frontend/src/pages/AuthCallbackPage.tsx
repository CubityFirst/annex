import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminSignInError, exchangeAdminCode } from "@/lib/api";
import { setToken } from "@/lib/auth";
import { adminSignInUrl, normalizeAdminNextPath, rememberPostSignIn, signInErrorMessage } from "@/lib/signIn";

interface AuthCallbackPageProps {
  onAuthenticated: () => Promise<void> | void;
}

// /auth/complete - where the admin worker's /api/auth/callback sends the
// browser. The outcome is in the URL fragment (never sent to servers):
//   #status=ok&return_to=/path  -> redeem the single-use HttpOnly handoff
//                                  cookie for the admin session JWT
//   #error=<code>               -> explain and offer a retry
// Read once at module level of the effect, before the address bar is cleaned.
function readFragment(): URLSearchParams {
  return new URLSearchParams(window.location.hash.slice(1));
}

export function AuthCallbackPage({ onAuthenticated }: AuthCallbackPageProps) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [nextPath] = useState(() => normalizeAdminNextPath(readFragment().get("return_to")));
  const [ok] = useState(() => readFragment().get("status") === "ok");
  // One exchange per mount (StrictMode re-runs the effect; see exchangeAdminCode).
  const [attempt] = useState(() => crypto.randomUUID());
  const [errorCode] = useState(() => readFragment().get("error"));

  useEffect(() => {
    // Strip the one-time code from the address bar / history immediately,
    // before (and regardless of) the exchange.
    window.history.replaceState(null, "", window.location.pathname);

    if (!ok) {
      setError(signInErrorMessage(errorCode));
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const { token } = await exchangeAdminCode(attempt);
        setToken(token);
        // App shows its verification screen (unmounting this page) and then
        // redirects /auth/complete to this destination.
        rememberPostSignIn(nextPath);
        await onAuthenticated();
        if (!cancelled) navigate(nextPath, { replace: true });
      } catch (err) {
        if (!cancelled) setError(signInErrorMessage(err instanceof AdminSignInError ? err.code : null));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ok, attempt, errorCode, navigate, nextPath, onAuthenticated]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12 text-foreground">
      <Card className="w-full max-w-md">
        <CardHeader className="flex flex-col items-center gap-2 text-center">
          <Shield className="h-8 w-8 text-primary" />
          <CardTitle className="text-2xl">Annex Admin</CardTitle>
          <p className="text-sm text-muted-foreground">
            {error ? "Admin sign-in needs attention" : "Finishing your sign-in..."}
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? (
            <>
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
              <Button asChild>
                {/* prompt=login so a non-admin can switch to another account */}
                <a href={adminSignInUrl(nextPath, { prompt: "login" })}>Try again</a>
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Exchanging your sign-in for an admin session now.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
