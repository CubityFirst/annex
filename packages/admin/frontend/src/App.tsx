import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { KeyRound, ScrollText, Users, Boxes } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ADMIN_AUTH_INVALIDATED_EVENT, clearToken, getToken } from "@/lib/auth";
import { buildDocsAdminLoginUrl } from "@/lib/handoff";
import { type AdminAuthSession, TransientVerifyError, logoutAdminSession, verifyAdminSession } from "@/lib/api";
import { AuthCallbackPage } from "./pages/AuthCallbackPage";
import { LoginPage } from "./pages/LoginPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { UsersPage } from "./pages/UsersPage";
import { AuditPage } from "./pages/AuditPage";
import { OAuthClientsPage } from "./pages/OAuthClientsPage";

function AdminLayout({
  session,
  onLogout,
}: {
  session: AdminAuthSession;
  onLogout: () => void;
}) {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 sm:gap-6 sm:px-6">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <img src="/annexwordmark.svg" alt="Annex" className="h-5 w-auto" />
          <span className="text-muted-foreground">Admin</span>
        </div>

        <nav className="order-last -mx-1 flex w-full gap-1 overflow-x-auto px-1 sm:order-none sm:mx-0 sm:w-auto sm:overflow-visible sm:px-0">
          <Button
            variant={location.pathname === "/" ? "secondary" : "ghost"}
            size="sm"
            asChild
          >
            <Link to="/">
              <Users className="h-4 w-4" />
              Users
            </Link>
          </Button>
          <Button
            variant={location.pathname === "/projects" ? "secondary" : "ghost"}
            size="sm"
            asChild
          >
            <Link to="/projects">
              <Boxes className="h-4 w-4" />
              Projects
            </Link>
          </Button>
          <Button
            variant={location.pathname === "/audit" ? "secondary" : "ghost"}
            size="sm"
            asChild
          >
            <Link to="/audit">
              <ScrollText className="h-4 w-4" />
              Audit
            </Link>
          </Button>
          <Button
            variant={location.pathname === "/oauth-clients" ? "secondary" : "ghost"}
            size="sm"
            asChild
          >
            <Link to="/oauth-clients">
              <KeyRound className="h-4 w-4" />
              OAuth
            </Link>
          </Button>
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <span className="max-w-[45vw] truncate text-sm text-muted-foreground sm:max-w-[40vw]">
            {session.email}
          </span>
          <Button size="sm" variant="outline" onClick={onLogout}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <Routes>
          <Route path="/" element={<UsersPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/oauth-clients" element={<OAuthClientsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [session, setSession] = useState<AdminAuthSession | null>(null);
  const [checking, setChecking] = useState(true);
  // Set when the session couldn't be VERIFIED (network down, API 5xx) as
  // opposed to being invalid - the token is kept and the operator gets a
  // retry instead of being bounced through a full re-handoff.
  const [verifyBlocked, setVerifyBlocked] = useState<string | null>(null);
  // Latest session for the stable refreshSession callback (its deps are
  // empty so the closed-over `session` would always be the initial null).
  const sessionRef = useRef<AdminAuthSession | null>(null);
  sessionRef.current = session;

  const refreshSession = useCallback(async (silent = false) => {
    const token = getToken();

    if (!token) {
      setSession(null);
      setChecking(false);
      return;
    }

    // `silent` re-checks (tab refocus) must not flash the full-screen
    // "Checking..." takeover; the initial mount check still shows it.
    if (!silent) setChecking(true);

    try {
      const next = await verifyAdminSession();
      setVerifyBlocked(null);
      // Defense-in-depth: the server already rejects expired sessions,
      // but enforce the token's own expiry client-side too so a stale
      // token can never leave the admin shell rendered.
      if (next.expiresAt <= Date.now()) {
        clearToken();
        setSession(null);
      } else {
        setSession(next);
      }
    } catch (err) {
      if (err instanceof TransientVerifyError) {
        // Can't reach the API right now - do NOT log the operator out over
        // a WiFi blip. Keep any live session rendered; if there is none
        // yet, show a retry screen instead of the login page.
        if (!sessionRef.current) setVerifyBlocked(err.message);
      } else {
        clearToken();
        setSession(null);
      }
    } finally {
      if (!silent) setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  // Re-validate when the operator returns to the tab: a session can
  // expire or be revoked while the tab is backgrounded, and we don't
  // want the admin UI to stay usable until the next API call 401s.
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === "visible" && getToken()) {
        void refreshSession(true);
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refreshSession]);

  useEffect(() => {
    function handleAdminAuthInvalidated() {
      setSession(null);
      setChecking(false);

      if (location.pathname === "/login" || location.pathname === "/auth/callback") {
        return;
      }

      navigate("/login", {
        replace: true,
        state: { from: `${location.pathname}${location.search}` || "/" },
      });
    }

    window.addEventListener(ADMIN_AUTH_INVALIDATED_EVENT, handleAdminAuthInvalidated);
    return () => {
      window.removeEventListener(ADMIN_AUTH_INVALIDATED_EVENT, handleAdminAuthInvalidated);
    };
  }, [location.pathname, location.search, navigate]);

  async function handleLogout() {
    // Revoke the session server-side FIRST (while the token still works):
    // clearing local state alone would leave any copy of the token valid
    // until its TTL. Best-effort - local sign-out proceeds regardless.
    try {
      await logoutAdminSession();
    } catch {
      /* offline / already-revoked - still sign out locally */
    }
    clearToken();
    setSession(null);
    window.location.assign(buildDocsAdminLoginUrl("/", { logout: true }));
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Checking admin session...
      </div>
    );
  }

  if (!session && verifyBlocked) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center">
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t reach the admin API to verify your session ({verifyBlocked}).
          Your sign-in is kept - retry when you&apos;re back online.
        </p>
        <Button size="sm" variant="outline" onClick={() => { setVerifyBlocked(null); void refreshSession(); }}>
          Retry
        </Button>
      </div>
    );
  }

  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage onAuthenticated={refreshSession} />} />
        <Route
          path="*"
          element={
            <Navigate
              to="/login"
              replace
              state={{ from: `${location.pathname}${location.search}` || "/" }}
            />
          }
        />
      </Routes>
    );
  }

  if (location.pathname === "/login" || location.pathname === "/auth/callback") {
    return <Navigate to="/" replace />;
  }

  return <AdminLayout session={session} onLogout={handleLogout} />;
}
