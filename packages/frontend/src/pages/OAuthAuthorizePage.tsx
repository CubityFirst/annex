import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { clearToken, getToken } from "@/lib/auth";

// Browser-facing OIDC authorization endpoint (the `authorization_endpoint` in
// discovery). A connected service's OIDC library redirects the browser here
// with the standard query params; this page orchestrates the Annex login (if
// needed), an optional consent gate, and the redirect back to the service with
// a single-use `code`. All validation + code minting happens server-side at
// /api/oauth/authorize — this page never constructs the redirect itself.

interface OidcParams {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  scope: string;
  state?: string;
  nonce?: string;
  code_challenge: string;
  code_challenge_method: string;
}

interface ConsentInfo {
  clientName: string;
  scope: string;
  email: string;
}

const SCOPE_LABELS: Record<string, string> = {
  openid: "Confirm your identity",
  profile: "Your display name and profile photo",
  email: "Your email address",
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid_client: "This app isn't recognised. The link may be misconfigured.",
  invalid_redirect_uri: "This app's return address isn't allowed. The link may be misconfigured.",
  missing_params: "The sign-in request was incomplete. Please return to the app and try again.",
};

function readParams(search: string): OidcParams | null {
  const p = new URLSearchParams(search);
  const client_id = p.get("client_id");
  const redirect_uri = p.get("redirect_uri");
  const code_challenge = p.get("code_challenge");
  if (!client_id || !redirect_uri || !code_challenge) return null;
  return {
    client_id,
    redirect_uri,
    response_type: p.get("response_type") ?? "code",
    scope: p.get("scope") ?? "openid",
    state: p.get("state") ?? undefined,
    nonce: p.get("nonce") ?? undefined,
    code_challenge,
    code_challenge_method: p.get("code_challenge_method") ?? "",
  };
}

export function OAuthAuthorizePage() {
  const location = useLocation();
  const params = readParams(location.search);
  const [status, setStatus] = useState<"loading" | "consent" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState<ConsentInfo | null>(null);
  const startedRef = useRef(false);

  // POST the OIDC request to the backend. `decision` carries the consent
  // outcome on the second call. A `redirectTo` in the response is followed
  // verbatim (it always points at the validated redirect_uri).
  const submit = useCallback(
    async (decision?: { approved?: boolean; denied?: boolean }) => {
      if (!params) {
        setError(ERROR_MESSAGES.missing_params);
        setStatus("error");
        return;
      }
      try {
        const res = await fetch("/api/oauth/authorize", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${getToken()}`,
          },
          body: JSON.stringify({ ...params, ...decision }),
        });

        // Token missing/expired → re-authenticate, then return here.
        if (res.status === 401) {
          clearToken();
          const next = encodeURIComponent(location.pathname + location.search);
          window.location.assign(`/login?next=${next}`);
          return;
        }

        const json = (await res.json()) as {
          ok: boolean;
          error?: string;
          data?: {
            redirectTo?: string;
            consentRequired?: boolean;
            client?: { name: string };
            scope?: string;
            email?: string;
          };
        };

        if (!json.ok) {
          setError(ERROR_MESSAGES[json.error ?? ""] ?? "This sign-in request couldn't be completed.");
          setStatus("error");
          return;
        }

        if (json.data?.redirectTo) {
          window.location.assign(json.data.redirectTo);
          return;
        }

        if (json.data?.consentRequired) {
          setConsent({
            clientName: json.data.client?.name ?? "An app",
            scope: json.data.scope ?? params.scope,
            email: json.data.email ?? "",
          });
          setStatus("consent");
          return;
        }

        setError("This sign-in request couldn't be completed.");
        setStatus("error");
      } catch {
        setError("Couldn't reach Annex to complete sign-in. Please try again.");
        setStatus("error");
      }
    },
    [params, location.pathname, location.search],
  );

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    if (!params) {
      setError(ERROR_MESSAGES.missing_params);
      setStatus("error");
      return;
    }

    // No Annex session yet → bounce through login and come straight back.
    if (!getToken()) {
      const next = encodeURIComponent(location.pathname + location.search);
      window.location.assign(`/login?next=${next}`);
      return;
    }

    void submit();
  }, [params, location.pathname, location.search, submit]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12 text-foreground">
      <Card className="w-full max-w-md">
        <CardHeader className="flex flex-col items-center gap-2 text-center">
          <KeyRound className="h-8 w-8 text-primary" />
          <CardTitle className="text-2xl">Sign in with Annex</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {status === "loading" && (
            <p className="text-center text-sm text-muted-foreground">Completing sign-in…</p>
          )}

          {status === "consent" && consent && (
            <>
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{consent.clientName}</span> wants to sign you
                in{consent.email ? <> as <span className="font-medium text-foreground">{consent.email}</span></> : null}.
              </p>
              <ul className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3 text-sm">
                {consent.scope.split(/\s+/).filter(Boolean).map((s) => (
                  <li key={s} className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    {SCOPE_LABELS[s] ?? s}
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => void submit({ denied: true })}>
                  Cancel
                </Button>
                <Button className="flex-1" onClick={() => void submit({ approved: true })}>
                  Allow
                </Button>
              </div>
            </>
          )}

          {status === "error" && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
