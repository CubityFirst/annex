import { useEffect, useState } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { UserProfileCard } from "@/components/UserProfileCard";
import { getToken } from "@/lib/auth";

/** The standalone profile "page" (a full-page profile card) for a resolved user id. */
export function UserProfileView({ userId, initialName = "" }: { userId: string; initialName?: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const cameFromInApp = Boolean((location.state as { backgroundLocation?: unknown } | null)?.backgroundLocation);
  const [name, setName] = useState<string>(initialName);

  useEffect(() => {
    if (initialName) return;
    let cancelled = false;
    const token = getToken();
    fetch(`/api/users/${userId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((json: { ok: boolean; data?: { name: string } }) => {
        if (!cancelled && json.ok && json.data) setName(json.data.name);
      })
      .catch(() => { /* UserProfileCard handles its own fetch + error state */ });
    return () => { cancelled = true; };
  }, [userId, initialName]);

  return (
    <UserProfileCard
      key={userId}
      userId={userId}
      name={name}
      open
      onOpenChange={next => {
        if (next) return;
        if (cameFromInApp) navigate(-1);
        else navigate("/dashboard");
      }}
      forceViewAsPublic
      standalone
    />
  );
}

export function UserProfilePage() {
  const { userId } = useParams<{ userId: string }>();
  if (!userId) return null;
  return <UserProfileView userId={userId} />;
}
