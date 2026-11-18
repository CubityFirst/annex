import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthForm } from "@/components/AuthForm";
import { setToken } from "@/lib/auth";
import { safeReturnTo, signInErrorMessage, startSignIn } from "@/lib/signIn";

// /auth/complete - where /api/auth/callback sends the browser. The outcome is
// in the URL fragment (never sent to servers or in Referer headers):
//   #code=<single-use>&return_to=/path   -> redeem for the session JWT
//   #error=<code>                        -> explain and offer a retry
export function AuthCompletePage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState("/dashboard");
  const started = useRef(false);

  useEffect(() => {
    // StrictMode runs effects twice in dev; the code is single use.
    if (started.current) return;
    started.current = true;

    const fragment = new URLSearchParams(window.location.hash.slice(1));
    // Drop the code from the address bar and history straight away.
    window.history.replaceState(null, "", window.location.pathname);
    const next = safeReturnTo(fragment.get("return_to")) ?? "/dashboard";
    setReturnTo(next);

    const code = fragment.get("code");
    if (!code) {
      setError(signInErrorMessage(fragment.get("error")));
      return;
    }
    (async () => {
      try {
        const res = await fetch("/api/auth/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        const json = (await res.json()) as { ok: boolean; data?: { token: string }; error?: string };
        if (!json.ok || !json.data) {
          setError(signInErrorMessage(json.error ?? "invalid_code"));
          return;
        }
        setToken(json.data.token);
        navigate(next, { replace: true });
      } catch {
        setError(signInErrorMessage("identity_unavailable"));
      }
    })();
  }, [navigate]);

  return (
    <AuthForm
      wordmark={<img src="/annexwordmark.svg" alt="Annex" className="h-7 w-auto dark:invert" />}
      title="Annex"
      subtitle={error ? "Couldn't sign you in" : "Signing you in…"}
      submitLabel="Try again"
      hideSubmit={!error}
      error={error}
      onSubmit={e => {
        e.preventDefault();
        startSignIn(returnTo);
      }}
      footer={<a href="/" className="text-primary underline-offset-4 hover:underline inline-flex min-h-11 items-center px-1">Back to the home page</a>}
    >
      {null}
    </AuthForm>
  );
}

// /oauth/authorize - the authorization endpoint moved to the identity service.
// Kept as a redirect (query string included) for services that hard-coded the
// old URL. The frontend worker does the same redirect server-side in
// production; this covers the SPA route (local dev, client-side navigation).
export function OAuthAuthorizeRedirect({ origin }: { origin: string }) {
  useEffect(() => {
    window.location.replace(`${origin}/oauth/authorize${window.location.search}`);
  }, [origin]);
  return null;
}
