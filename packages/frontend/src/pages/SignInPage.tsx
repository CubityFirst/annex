import { Fragment, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AuthForm, AUTH_BUTTON_CLASS } from "@/components/AuthForm";
import { getToken, setToken } from "@/lib/auth";
import { IDENTITY_ORIGIN, safeReturnTo, startSignIn } from "@/lib/signIn";

// /login and /register. Accounts live on auth.cubityfir.st now, so both just
// hand off to the hosted sign-in page (which links to registration and comes
// back here afterwards). The page itself only shows when there's something
// to say first: a forced sign-out reason, or the local-dev quick logins.

function reasonNotice(reason: string | null): string | null {
  const contact = "Please email docs@cubityfir.st for further details.";
  if (reason === "disabled") return `Your account has been disabled. ${contact}`;
  if (reason === "suspended") return `Your account is currently suspended. ${contact}`;
  if (reason === "expired") return "Your session has ended. Please sign in again.";
  return null;
}

const annexWordmark = <img src="/annexwordmark.svg" alt="Annex" className="h-7 w-auto dark:invert" />;

type DevVariant = "standard-free" | "standard-ink" | "admin-free" | "admin-ink";

export function SignInPage({ mode = "signin" }: { mode?: "signin" | "register" }) {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const reason = params.get("reason");
  const notice = reasonNotice(reason);
  const returnTo = useMemo(
    () => safeReturnTo(params.get("next")) ?? safeReturnTo((location.state as { from?: string } | null)?.from) ?? "/dashboard",
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [location.search, location.state],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hand straight off to the identity service unless there's a notice to
  // read first or this is a dev build (where the quick logins live). A
  // disabled/suspended user would otherwise loop straight back here.
  const stayOnPage = Boolean(notice && reason !== "expired") || import.meta.env.DEV;
  useEffect(() => {
    if (getToken()) {
      navigate(returnTo, { replace: true });
      return;
    }
    if (!stayOnPage) startSignIn(returnTo);
  }, [navigate, returnTo, stayOnPage]);

  async function handleDevLogin(variant: DevVariant) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dev/quick-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant }),
      });
      const json = (await res.json()) as { ok: boolean; data?: { token: string } };
      if (json.ok && json.data) {
        setToken(json.data.token);
        navigate(returnTo, { replace: true });
      } else {
        setError("Dev quick login failed (is DEV_QUICK_LOGIN=true set for the api worker?).");
      }
    } catch {
      setError("Could not connect to the server.");
    } finally {
      setLoading(false);
    }
  }

  const host = new URL(IDENTITY_ORIGIN).host;

  return (
    <AuthForm
      wordmark={annexWordmark}
      title="Annex"
      subtitle={mode === "register" ? "Create your Annex account" : "Sign in to Annex"}
      submitLabel={`Continue with ${host}`}
      loading={loading}
      error={error}
      onSubmit={e => {
        e.preventDefault();
        setLoading(true);
        startSignIn(returnTo);
      }}
      header={notice ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      footer={
        <>
          Annex accounts are managed at{" "}
          <a href={IDENTITY_ORIGIN} className="text-primary underline-offset-4 hover:underline inline-flex min-h-11 items-center px-1">
            {host}
          </a>
          {mode === "register" ? ". Create one there and you'll come straight back." : "."}
        </>
      }
      devPanel={import.meta.env.DEV ? (
        <div className="grid grid-cols-[4.5rem_1fr_1fr] items-center gap-2">
          {(
            [
              { label: "Standard", free: "standard-free", ink: "standard-ink" },
              { label: "Admin", free: "admin-free", ink: "admin-ink" },
            ] as const
          ).map(({ label, free, ink }) => (
            <Fragment key={label}>
              <span className="text-sm text-muted-foreground">{label}</span>
              <Button type="button" variant="outline" size="sm" className={`${AUTH_BUTTON_CLASS} w-full`} disabled={loading} onClick={() => void handleDevLogin(free)}>Free</Button>
              <Button type="button" variant="outline" size="sm" className={`${AUTH_BUTTON_CLASS} w-full`} disabled={loading} onClick={() => void handleDevLogin(ink)}>Ink</Button>
            </Fragment>
          ))}
        </div>
      ) : undefined}
    >
      <p className="text-sm text-muted-foreground">
        {mode === "register"
          ? "You'll create your account on the sign-in page, then come back here."
          : "You'll sign in on the secure sign-in page, then come back here."}
      </p>
    </AuthForm>
  );
}
