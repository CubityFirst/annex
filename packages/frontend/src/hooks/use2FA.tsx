import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { getToken } from "@/lib/auth";
import { startWebauthnAuth } from "@/lib/webauthn";
import { KeyRound, Smartphone, Hash } from "lucide-react";

export type TwoFAVerification = {
  totpCode?: string;
  challengeId?: string;
  webauthnResponse?: unknown;
  backupCode?: string;
};

// Return undefined on success, an error message string on failure (keeps dialog open).
export type TwoFAAction = (v: TwoFAVerification) => Promise<string | undefined>;

type DialogMode = "pick" | "totp" | "webauthn" | "backup";

/**
 * Reusable MFA gate hook.
 *
 * - Both totp + webauthn → shows method picker dialog
 * - totp only            → TOTP dialog
 * - webauthn only        → triggers WebAuthn ceremony directly
 * - neither              → calls action immediately with no verification
 */
export function use2FA({
  totp,
  webauthn,
}: {
  totp: boolean;
  webauthn: boolean;
}) {
  const hasMFA = totp || webauthn;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<DialogMode>("pick");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [webauthnStatus, setWebauthnStatus] = useState<"waiting" | "error">("waiting");
  const { toast } = useToast();

  const pendingRef = useRef<{
    action: TwoFAAction;
    resolve: () => void;
  } | null>(null);

  async function runWebauthnInDialog() {
    if (!pendingRef.current) return;
    setBusy(true);
    setWebauthnStatus("waiting");
    setFieldError(null);
    try {
      const token = getToken();
      const startRes = await fetch("/api/me/webauthn/auth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      const startJson = await startRes.json() as {
        ok: boolean;
        data?: { options: Record<string, unknown>; challengeId: string };
      };
      if (!startJson.ok || !startJson.data) {
        setFieldError("Could not start security key verification.");
        setWebauthnStatus("error");
        return;
      }
      const { options, challengeId } = startJson.data;
      let assertion;
      try {
        assertion = await startWebauthnAuth(options);
      } catch {
        setFieldError("Security key verification was cancelled. Try again or use your authenticator app.");
        setWebauthnStatus("error");
        return;
      }
      const err = await pendingRef.current.action({ challengeId, webauthnResponse: assertion });
      if (err === undefined) {
        const { resolve } = pendingRef.current;
        pendingRef.current = null;
        setOpen(false);
        setCode("");
        resolve();
      } else {
        setFieldError(err);
        setWebauthnStatus("error");
      }
    } catch {
      setFieldError("Could not connect to the server.");
      setWebauthnStatus("error");
    } finally {
      setBusy(false);
    }
  }

  // Auto-trigger WebAuthn ceremony when mode switches to webauthn
  useEffect(() => {
    if (open && mode === "webauthn") {
      runWebauthnInDialog();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  function initialMode(): DialogMode {
    if (totp && webauthn) return "pick";
    if (totp) return "totp";
    return "webauthn";
  }

  async function runWithTwoFA(action: TwoFAAction): Promise<void> {
    if (hasMFA) {
      return new Promise<void>((resolve) => {
        pendingRef.current = { action, resolve };
        setCode("");
        setFieldError(null);
        setWebauthnStatus("waiting");
        setMode(initialMode());
        setOpen(true);
      });
    }

    // No MFA set up - proceed directly
    await action({});
  }

  function closeDialog() {
    setOpen(false);
    setCode("");
    setFieldError(null);
    if (pendingRef.current) {
      pendingRef.current.resolve();
      pendingRef.current = null;
    }
  }

  async function handleTotpSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingRef.current || code.length !== 6) return;
    setBusy(true);
    const { action, resolve } = pendingRef.current;
    const err = await action({ totpCode: code });
    setBusy(false);
    if (err === undefined) {
      pendingRef.current = null;
      setOpen(false);
      setCode("");
      resolve();
    } else {
      setFieldError(err);
      setCode("");
    }
  }

  async function handleBackupSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingRef.current || !code.trim()) return;
    setBusy(true);
    const { action, resolve } = pendingRef.current;
    const err = await action({ backupCode: code.trim() });
    setBusy(false);
    if (err === undefined) {
      pendingRef.current = null;
      setOpen(false);
      setCode("");
      resolve();
    } else {
      setFieldError(err);
      setCode("");
    }
  }

  const twoFADialog = (
    <Dialog open={open} onOpenChange={o => { if (!o) closeDialog(); }}>
      <DialogContent hideClose>
        <DialogHeader>
          <DialogTitle>Confirm identity</DialogTitle>
        </DialogHeader>

        {mode === "pick" ? (
          <div className="py-2 flex flex-col gap-3">
            {webauthn && (
              <Button
                variant="outline"
                className="w-full h-12 text-base"
                onClick={() => setMode("webauthn")}
              >
                <KeyRound className="size-4 mr-2" />
                Security key
              </Button>
            )}
            {totp && (
              <Button
                variant="outline"
                className="w-full h-12 text-base"
                onClick={() => setMode("totp")}
              >
                <Smartphone className="size-4 mr-2" />
                Authenticator app
              </Button>
            )}
            {totp && (
              <Button
                variant="outline"
                className="w-full h-12 text-base"
                onClick={() => setMode("backup")}
              >
                <Hash className="size-4 mr-2" />
                Backup code
              </Button>
            )}
          </div>
        ) : mode === "totp" ? (
          <form id="2fa-confirm-form" onSubmit={handleTotpSubmit} className="pt-6 pb-4">
            <div className="flex flex-col gap-3 items-center">
              <Label>Enter the 6-digit code from your app</Label>
              <InputOTP
                maxLength={6}
                value={code}
                onChange={v => { setCode(v); setFieldError(null); }}
                autoComplete="one-time-code"
                autoFocus
              >
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
              {fieldError && <p className="text-xs text-destructive">{fieldError}</p>}
            </div>
          </form>
        ) : mode === "webauthn" ? (
          <div className="py-2 flex flex-col gap-2">
            {webauthnStatus === "waiting" && !fieldError ? (
              <p className="text-sm text-muted-foreground">
                Touch your security key when it flashes…
              </p>
            ) : (
              <>
                {fieldError && <p className="text-xs text-destructive">{fieldError}</p>}
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={runWebauthnInDialog}
                >
                  Try again
                </Button>
              </>
            )}
          </div>
        ) : (
          <form id="2fa-confirm-form" onSubmit={handleBackupSubmit} className="pt-6 pb-4">
            <div className="flex flex-col gap-3">
              <Label htmlFor="backup-code-input">Enter a backup code</Label>
              <Input
                id="backup-code-input"
                value={code}
                onChange={e => { setCode(e.target.value); setFieldError(null); }}
                placeholder="XXXXX-XXXXX"
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
              {fieldError && <p className="text-xs text-destructive">{fieldError}</p>}
            </div>
          </form>
        )}

        <DialogFooter>
          <Button variant="outline" type="button" onClick={closeDialog} className="mr-auto">
            Cancel
          </Button>
          {mode !== "pick" && (totp || webauthn) && (
            <button
              type="button"
              className="text-xs text-primary underline-offset-4 hover:underline"
              onClick={() => { setFieldError(null); setCode(""); setMode("pick"); }}
            >
              Use a different method
            </button>
          )}
          {(mode === "totp" || mode === "backup") && (
            <Button type="submit" form="2fa-confirm-form" disabled={busy || code.length === 0}>
              {busy ? "Confirming…" : "Confirm"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { runWithTwoFA, twoFADialog, busy };
}
