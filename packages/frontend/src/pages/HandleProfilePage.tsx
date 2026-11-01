import { useEffect, useState } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import { getToken } from "@/lib/auth";
import { normalizeHandle, handleProblem } from "@/lib/handle";
import { UserProfileView } from "./UserProfilePage";
import { NotFound404 } from "./NotFound404";

type Resolved =
  | { status: "loading" }
  | { status: "found"; handle: string; userId: string; name: string }
  | { status: "missing"; handle: string };

/**
 * `/@<handle>` - the opt-in vanity profile link. Mounted on the single-segment
 * `/:atHandle` route (React Router 6 can't express a literal `@` prefix on a
 * param), so anything that doesn't start with `@` isn't ours and renders
 * nothing; App.tsx's gate shows the real 404 for those.
 */
export function HandleProfilePage() {
  const { atHandle = "" } = useParams<{ atHandle: string }>();
  const location = useLocation();
  const isHandlePath = atHandle.startsWith("@");
  const raw = atHandle.slice(1);
  const handle = normalizeHandle(raw);
  // Reserved names are only barred from self-service claiming; an admin may
  // assign one, so they must still resolve here.
  const problem = handleProblem(handle);
  const valid = isHandlePath && (problem === null || problem === "reserved");
  const [resolved, setResolved] = useState<Resolved>({ status: "loading" });

  useEffect(() => {
    // Wait for the canonical (lowercased) URL before fetching.
    if (!valid || raw !== handle) return;
    let cancelled = false;
    fetch(`/api/users/by-handle/${encodeURIComponent(handle)}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
      .then(r => r.json() as Promise<{ ok: boolean; data?: { userId: string; name: string } }>)
      .then(json => {
        if (cancelled) return;
        setResolved(json.ok && json.data
          ? { status: "found", handle, userId: json.data.userId, name: json.data.name }
          : { status: "missing", handle });
      })
      .catch(() => { if (!cancelled) setResolved({ status: "missing", handle }); });
    return () => { cancelled = true; };
  }, [valid, raw, handle]);

  if (!isHandlePath) return null;
  // Handles are stored lowercase; canonicalize /@Someone → /@someone, keeping
  // any background-location state so the in-app modal still works.
  if (valid && raw !== handle) {
    return <Navigate to={`/@${handle}${location.search}`} replace state={location.state} />;
  }
  // A result for a different handle (we just navigated /@a → /@b) is stale.
  const current = resolved.status !== "loading" && resolved.handle === handle ? resolved : null;
  if (!valid || current?.status === "missing") {
    return (
      <NotFound404
        subtitle={<>Nobody is using <strong>@{raw}</strong> as their profile link. They may have changed it or turned it off.</>}
        primaryLabel="Go to dashboard"
        primaryHref="/dashboard"
      />
    );
  }
  if (current?.status !== "found") return null;
  return <UserProfileView userId={current.userId} initialName={current.name} />;
}
