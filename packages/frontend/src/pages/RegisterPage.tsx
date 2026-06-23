import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import zxcvbn from "zxcvbn";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthForm } from "@/components/AuthForm";
import { Turnstile } from "@/components/Turnstile";
import { getToken, setToken } from "@/lib/auth";

const annexWordmark = <img src="/annexwordmark.svg" alt="Annex" className="h-10 w-auto dark:invert" />;

const STRENGTH_LABELS = ["Very weak", "Weak", "Fair", "Strong", "Very strong"];
const STRENGTH_COLORS = [
  "bg-red-500",
  "bg-orange-500",
  "bg-yellow-500",
  "bg-blue-500",
  "bg-green-500",
];

export function RegisterPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleTurnstileVerify = useCallback((token: string) => setTurnstileToken(token), []);
  const handleTurnstileExpire = useCallback(() => setTurnstileToken(null), []);

  const strength = password ? zxcvbn(password) : null;
  const score = strength?.score ?? -1;

  useEffect(() => {
    if (getToken()) {
      navigate("/dashboard", { replace: true });
    }
  }, [navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (score < 3) {
      setError("Please choose a stronger password.");
      return;
    }
    if (!turnstileToken) {
      setError("Please complete the security challenge.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password, turnstileToken }),
      });
      const json = await res.json() as { ok: boolean; data?: { email: string; verificationSent: boolean; token?: string }; error?: string };
      if (json.ok && json.data) {
        if (json.data.verificationSent) {
          navigate("/check-email", { replace: true, state: { email: json.data.email } });
        } else if (json.data.token) {
          setToken(json.data.token);
          navigate("/dashboard", { replace: true });
        } else {
          navigate("/login", { replace: true });
        }
      } else {
        setError(
          res.status === 409
            ? "An account with that email already exists."
            : res.status === 403 && json.error
              ? json.error
              : "Registration failed. Please try again.",
        );
      }
    } catch {
      setError("Could not connect to the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthForm
      wordmark={annexWordmark}
      title="Annex"
      subtitle="Create an account"
      submitLabel="Create account"
      loading={loading}
      error={error}
      onSubmit={handleSubmit}
      footer={
        <>
          Already have an account?{" "}
          <a href="/login" className="text-primary underline-offset-4 hover:underline">
            Sign in
          </a>
        </>
      }
    >
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          type="text"
          placeholder="Your name"
          value={name}
          onChange={e => setName(e.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
        />
        {password && (
          <div className="space-y-1">
            <div className="flex gap-1">
              {[0, 1, 2, 3, 4].map(i => (
                <div
                  key={i}
                  className={`h-1 flex-1 rounded-full transition-colors ${i <= score ? STRENGTH_COLORS[score] : "bg-muted"}`}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{STRENGTH_LABELS[score]}</p>
          </div>
        )}
      </div>
      <Turnstile onVerify={handleTurnstileVerify} onExpire={handleTurnstileExpire} />
    </AuthForm>
  );
}
