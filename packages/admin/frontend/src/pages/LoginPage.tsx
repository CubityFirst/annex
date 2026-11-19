import { useLocation } from "react-router-dom";
import { Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { adminSignInUrl, normalizeAdminNextPath } from "@/lib/signIn";

export function LoginPage() {
  const location = useLocation();
  const fromState = (location.state as { from?: string } | null)?.from;
  const nextPath = normalizeAdminNextPath(
    fromState ?? new URLSearchParams(location.search).get("next"),
  );

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12 text-foreground">
      <Card className="w-full max-w-md">
        <CardHeader className="flex flex-col items-center gap-2 text-center">
          <Shield className="h-8 w-8 text-primary" />
          <CardTitle className="text-2xl">Annex Admin</CardTitle>
          <p className="text-sm text-muted-foreground">
            Sign in with your cubityfir.st account. It needs the admin role.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            You&apos;ll sign in on auth.cubityfir.st with your password, authenticator app or passkey, then come back here.
          </p>
          <Button asChild>
            <a href={adminSignInUrl(nextPath)}>Continue to sign-in</a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
