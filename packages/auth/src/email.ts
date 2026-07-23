import type { Env } from "./index";

// Addresses are user input; escape them before interpolating into HTML bodies.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function sendVerificationEmail(
  env: Env,
  toEmail: string,
  verifyUrl: string,
): Promise<boolean> {
  try {
    await env.EMAIL.send({
      to: toEmail,
      from: "noreply@docs.cubityfir.st",
      subject: "Verify your Annex email address",
      text: [
        "Welcome to Annex!",
        "",
        "Did you create an account? If so, click the link below to verify your email address:",
        "",
        verifyUrl,
        "",
        "This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.",
      ].join("\n"),
      html: `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:480px;margin:40px auto;color:#111">
  <h2 style="margin-bottom:8px">Verify your email address</h2>
  <p>Welcome to Annex!</p>
  <p>Did you create an account? If so, click the button below to verify your email address.</p>
  <p style="margin:32px 0">
    <a href="${verifyUrl}"
       style="background:#000;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
      Verify email address
    </a>
  </p>
  <p style="color:#666;font-size:14px">This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.</p>
  <p style="color:#999;font-size:12px">If the button doesn't work, copy and paste this link into your browser:<br>${verifyUrl}</p>
</body>
</html>`,
    });
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    console.error("sendVerificationEmail failed", { code, err });
    return false;
  }
}

// Sent to the NEW address when a signed-in user requests an email change while
// verification is enforced - the change applies only when this link is clicked.
export async function sendEmailChangeConfirmEmail(
  env: Env,
  toEmail: string,
  verifyUrl: string,
): Promise<boolean> {
  try {
    await env.EMAIL.send({
      to: toEmail,
      from: "noreply@docs.cubityfir.st",
      subject: "Confirm your new Annex email address",
      text: [
        "You asked to change your Annex account email to this address.",
        "",
        "Click the link below to confirm the change:",
        "",
        verifyUrl,
        "",
        "This link expires in 24 hours. If you didn't request this change, you can safely ignore this email - your account email will stay as it is.",
      ].join("\n"),
      html: `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:480px;margin:40px auto;color:#111">
  <h2 style="margin-bottom:8px">Confirm your new email address</h2>
  <p>You asked to change your Annex account email to this address. Click the button below to confirm the change.</p>
  <p style="margin:32px 0">
    <a href="${verifyUrl}"
       style="background:#000;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
      Confirm email change
    </a>
  </p>
  <p style="color:#666;font-size:14px">This link expires in 24 hours. If you didn't request this change, you can safely ignore this email - your account email will stay as it is.</p>
  <p style="color:#999;font-size:12px">If the button doesn't work, copy and paste this link into your browser:<br>${verifyUrl}</p>
</body>
</html>`,
    });
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    console.error("sendEmailChangeConfirmEmail failed", { code, err });
    return false;
  }
}

// Security notice to the OLD address once an email change has actually applied.
export async function sendEmailChangedNotice(
  env: Env,
  oldEmail: string,
  newEmail: string,
): Promise<boolean> {
  try {
    await env.EMAIL.send({
      to: oldEmail,
      from: "noreply@docs.cubityfir.st",
      subject: "Your Annex account email was changed",
      text: [
        `The email address on your Annex account was changed to ${newEmail}.`,
        "",
        "If you made this change, no action is needed.",
        "",
        "If this wasn't you, your account may be compromised - sign in and change your password immediately.",
      ].join("\n"),
      html: `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:480px;margin:40px auto;color:#111">
  <h2 style="margin-bottom:8px">Your account email was changed</h2>
  <p>The email address on your Annex account was changed to <strong>${escapeHtml(newEmail)}</strong>.</p>
  <p>If you made this change, no action is needed.</p>
  <p style="color:#666;font-size:14px">If this wasn't you, your account may be compromised - sign in and change your password immediately.</p>
</body>
</html>`,
    });
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    console.error("sendEmailChangedNotice failed", { code, err });
    return false;
  }
}
