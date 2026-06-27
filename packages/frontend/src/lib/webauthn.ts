import { startAuthentication } from "@simplewebauthn/browser";

type AuthOptions = Record<string, unknown> & {
  allowCredentials?: Array<Record<string, unknown>>;
};

// Mobile platforms (Android Credential Manager, iOS AutoFill) aggregate every
// passkey provider - incl. a synced password manager like Bitwarden - into the
// modal `navigator.credentials.get()`, and actually *need* the
// allowCredentials[].transports hint (["internal","hybrid"]) to surface synced
// passkeys, so we leave the options untouched there.
function isMobilePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

// Desktop Chrome honors allowCredentials[].transports literally: an "internal"
// hint routes the request straight to the platform authenticator (Windows Hello
// / Touch ID) and "hybrid" to "use a phone", so a synced password-manager passkey
// (Bitwarden) is never offered - the user only sees the local-hardware / USB /
// NFC / "use another device" fallback. Dropping the hint lets the browser surface
// the full provider chooser (incl. an OS-registered Bitwarden provider).
function stripTransports(options: AuthOptions): AuthOptions {
  if (!Array.isArray(options.allowCredentials)) return options;
  return {
    ...options,
    allowCredentials: options.allowCredentials.map((cred) => {
      const next = { ...cred };
      delete next.transports;
      return next;
    }),
  };
}

// Wrapper around @simplewebauthn/browser's startAuthentication that relaxes the
// transport hints on desktop only - see stripTransports / isMobilePlatform.
export function startWebauthnAuth(options: AuthOptions) {
  const opts = isMobilePlatform() ? options : stripTransports(options);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return startAuthentication(opts as any);
}
