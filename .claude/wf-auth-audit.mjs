export const meta = {
  name: 'auth-worker-security-audit',
  description: 'Multi-agent security audit of the Annex auth worker (packages/auth) and its public auth.cubityfir.st surface',
  phases: [
    { title: 'Review', detail: 'one finder per security dimension, deep-reads the code' },
    { title: 'Verify', detail: 'adversarially refute each finding by re-reading the code' },
  ],
}

const ROOT = 'G:/Scripts/cubedocs/packages/auth'

const CONTEXT = [
  'You are auditing the Annex auth worker (a Cloudflare Worker) at ' + ROOT + '.',
  'Read the ACTUAL source with the Read tool - do not speculate. Cite file:line for every claim.',
  '',
  'ROUTING / EXPOSURE MODEL (from src/index.ts + wrangler.toml):',
  '- The worker has ONE fetch() router in src/index.ts dispatching by exact pathname+method.',
  '- PUBLICLY reachable on the internet at auth.cubityfir.st are ONLY: /oauth/token, /oauth/userinfo,',
  '  /oauth/jwks, /.well-known/openid-configuration (wrangler [[routes]] only expose /oauth/* and',
  '  /.well-known/*). These advertise CORS "*". /oauth/authorize is POST-only and reached via the app',
  '  proxy with a Bearer session token (CORS locked to https://docs.cubityfir.st).',
  '- Every OTHER route (login, register, totp, webauthn, sessions, billing, stripe webhook, admin/*,',
  '  dev/quick-login, update-*, lookup*, change-password, delete-account, verify*) is NOT on a public',
  '  auth.cubityfir.st route; it is reached through the API worker AUTH service binding / app /api',
  '  proxy. Treat these as reachable-by-authenticated-or-proxied callers and audit them too, but note',
  '  exposure level in each finding (PUBLIC vs PROXIED/SERVICE-BINDING).',
  '- Rate limiters: RATE_LIMITER_AUTH(10/min) on register/login/webauthn auth, RATE_LIMITER_LOOKUP(30/min)',
  '  on /lookup, RATE_LIMITER_EMAIL_VERIFY(3/min), RATE_LIMITER_OIDC(100/min) on /oauth/token. Note any',
  '  sensitive endpoint with NO limiter (e.g. /lookup-by-id, change-password, oauth/authorize, totp, billing).',
  '- Secrets: JWT_SECRET (HS session JWT), OIDC_PRIVATE_KEY (RS256 id_tokens), TURNSTILE_SECRET,',
  '  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.',
  '',
  'CROSS-PACKAGE NOTE: the API worker imports loadCurrentSession/verifyJwt directly from this package src/,',
  'and reads users/sessions/user_billing/user_preferences. Auth-DB schema is the shared boundary.',
  '',
  'For EACH finding return: title, severity (critical|high|medium|low|info), file, line (best estimate),',
  'endpoint (route + method, or "internal"), exposure (public|proxied|internal), category, description',
  '(what is wrong, mechanically), attack (concrete exploit scenario), recommendation (specific fix),',
  'confidence (0-1). Only report things grounded in the real code. Quote the relevant code snippet in the',
  'description. Do NOT pad with generic best-practice advice the code already follows - focus on actual',
  'weaknesses, missing checks, and risky patterns.',
].join('\n')

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'file', 'line', 'endpoint', 'exposure', 'category', 'description', 'attack', 'recommendation', 'confidence'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          endpoint: { type: 'string' },
          exposure: { type: 'string', enum: ['public', 'proxied', 'internal'] },
          category: { type: 'string' },
          description: { type: 'string' },
          attack: { type: 'string' },
          recommendation: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isReal', 'adjustedSeverity', 'reasoning', 'evidence'],
  properties: {
    isReal: { type: 'boolean' },
    adjustedSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info', 'invalid'] },
    reasoning: { type: 'string' },
    evidence: { type: 'string' },
  },
}

const DIMENSIONS = [
  { key: 'oidc-authorize', prompt: 'Audit the OIDC authorization step. Files: src/routes/oauth-authorize.ts, src/oidc.ts (authorize/code-issuance + client lookup + PKCE storage helpers). Check: exact redirect_uri match (no wildcards/substring/open-redirect), PKCE S256 required & stored, single-use code entropy + expiry, response_type/scope validation, state passthrough, disabled-client + suspended/unverified-user refusal at authorize, that the caller Bearer session is verified before a code is minted, code/user binding, and whether authorize has any rate limiting or CSRF consideration.' },
  { key: 'oidc-token', prompt: 'Audit the OIDC token endpoint (PUBLIC). Files: src/routes/oauth-token.ts, src/oidc.ts (code consumption, PKCE verify, id_token signing). Check: code single-use & consumed atomically, PKCE code_verifier verified BEFORE the code is consumed/honored, redirect_uri match at token time equals authorize time, client authentication (client_secret) constant-time compare, disabled client/suspended user refused, RS256 signing uses OIDC_PRIVATE_KEY (never JWT_SECRET), id_token claims (iss/aud/exp/iat/sub/nonce) correct, no code-replay race, RFC6749 error shape without leaking. Look hard for TOCTOU/ordering bugs around code consumption vs PKCE/secret verification.' },
  { key: 'oidc-userinfo-jwks', prompt: 'Audit OIDC userinfo, discovery, and JWKS (all PUBLIC). Files: src/routes/oauth-userinfo.ts, src/routes/oauth-discovery.ts, src/oidc.ts (token verify / jwks export). Check: userinfo access-token validation (alg pinned to RS256, iss/aud/exp checked, signature verified against right key), disabled-client/suspended-user refused at userinfo, scope-gated claim release, JWKS exposes ONLY public key material (never private), discovery doc correctness, and no PII over-exposure.' },
  { key: 'oidc-clients', prompt: 'Audit OIDC client management. Files: src/routes/oauth-clients.ts. Check: every handler (list/create/set-disabled/delete/rotate-secret) re-verifies an ADMIN session (reached via admin worker service binding but must not trust caller-supplied admin claims), client_secret generation entropy + hashed at rest (not plaintext) + shown once, redirect_uri validation on create, authorization on mutate (no IDOR across clients), and disable semantics.' },
  { key: 'login-register-password', prompt: 'Audit credential auth. Files: src/routes/login.ts, src/routes/register.ts, src/password.ts, src/crypto.ts, src/turnstile.ts. Check: password hashing (PBKDF2 params, salt, constant-time verify), user-enumeration via timing or differential responses/status on login & register, Turnstile verification actually enforced (not fail-open/bypassable), email normalization & uniqueness races, password policy, what login returns, account lockout vs only IP rate limiting, and whether a suspended/unverified user can still authenticate.' },
  { key: 'jwt-session', prompt: 'Audit JWT + session lifecycle. Files: src/jwt.ts, src/session.ts, src/sessions.ts, src/auth-session.ts, src/routes/verify.ts, src/routes/sessions-*.ts. Check: HS256 alg pinned on verify (alg-confusion / "none" rejected), signature + exp + iss validated, session token entropy, revocation enforced at read time, session fixation, sessions-revoke/revoke-others/logout authorization (can a caller revoke another user session? IDOR on session id), and the verify endpoint trust model. Note the cross-package loadCurrentSession contract.' },
  { key: 'mfa-totp-webauthn', prompt: 'Audit MFA. Files: src/mfa.ts, src/totp.ts, src/routes/totp-*.ts, src/webauthn.ts, src/routes/webauthn-*.ts. Check: TOTP secret generation/storage, TOTP code window & replay prevention, backup-code entropy + single-use + hashed storage, WebAuthn challenge generation/binding/expiry (challenge stored & matched, origin & rpId verified, signature counter checked for cloned authenticator), whether MFA can be skipped/bypassed in login, totp/disable & credentials/delete authorization, and whether auth/finish binds to the right user.' },
  { key: 'account-mgmt-handoff', prompt: 'Audit account management & admin handoff. Files: src/routes/change-password.ts, src/routes/force-change-password.ts, src/routes/delete-account.ts, src/routes/admin-handoff-start.ts, src/routes/admin-handoff-exchange.ts, src/admin-handoff.ts, src/routes/dev-quick-login.ts. Check: change-password requires current password/re-auth & has NO rate limiter, force-change-password trust model (who can call, can it change arbitrary users?), delete-account confirmation/authz, admin-handoff token entropy/expiry/single-use/binding (could it impersonate an arbitrary user or escalate to admin?), and CRITICALLY whether /dev/quick-login is gated by DEV_QUICK_LOGIN env in production (it is routed unconditionally in index.ts - confirm it cannot mint a session in prod).' },
  { key: 'stripe-billing', prompt: 'Audit billing. Files: src/routes/stripe-webhook.ts, src/routes/billing.ts, src/stripe-client.ts, src/plan.ts. Check: Stripe webhook signature verification (constant-time, correct secret, timestamp/replay tolerance, raw-body integrity not re-parsed), idempotency of webhook events, mapping customer/subscription -> user (can a forged or replayed event grant a plan/comp to an attacker?), billing/checkout & billing/portal authorization (IDOR on another user Stripe customer?), and plan-resolution trust (granted_plan vs personal_plan override).' },
  { key: 'lookup-email-profile', prompt: 'Audit data exposure + profile mutation. Files: src/routes/lookup.ts, src/routes/lookup-by-id.ts, src/routes/verify-email.ts, src/routes/verify-email-resend.ts, src/verification.ts, src/email.ts, src/routes/update-name.ts, src/routes/update-bio.ts, src/routes/update-timezone.ts, src/routes/update-ink-prefs.ts, src/routes/update-reading-font.ts, src/routes/update-theme.ts. Check: /lookup & /lookup-by-id user-enumeration / PII over-disclosure & that lookup-by-id has NO rate limiter, email-verification token entropy/expiry/single-use & whether resend enables email-bombing, email header/content injection via user fields, and on update-* routes: authn (operate only on own record), input validation/size limits, stored-XSS via bio/name, and ink-prefs privilege (can a non-supporter set supporter-only cosmetics?).' },
  { key: 'crosscutting-sqli-secrets', prompt: 'Audit cross-cutting concerns across ALL of src/. Check: SQL injection - verify EVERY D1 query uses .bind() parameterization (look for string-interpolated SQL / template literals in .prepare()), no raw concatenation of user input into SQL. Secret handling - secrets never logged (check console.error/log), never returned in responses, constant-time comparisons for secrets/tokens/codes (look for === on secret material). Error handling - individual handlers must not leak stack traces/internal detail/differential errors. CORS - the "*" on public OIDC paths combined with Authorization header: is any state-changing or credentialed endpoint exposed to "*" CORS? Input parsing - unhandled request.json() throwing, missing content-type checks, prototype pollution via spread of parsed JSON. Open redirect anywhere. Mass assignment in update-* via object spread.' },
]

phase('Review')

const results = await pipeline(
  DIMENSIONS,
  (d) => agent(CONTEXT + '\n\n=== YOUR DIMENSION: ' + d.key + ' ===\n' + d.prompt, {
    label: 'review:' + d.key,
    phase: 'Review',
    schema: FINDINGS_SCHEMA,
  }),
  (review, d) => {
    const findings = (review && review.findings) || []
    if (!findings.length) return []
    return parallel(findings.map((f) => () =>
      agent(
        'You are an adversarial security verifier auditing the Annex auth worker at ' + ROOT + '.\n' +
        'A prior reviewer reported the finding below. Your job is to REFUTE it. Open the cited file(s) with Read,\n' +
        'read the surrounding code and any helpers it calls, and determine whether the vulnerability is REAL and\n' +
        'EXPLOITABLE as described. Default to isReal=false unless the code concretely confirms it. Common false\n' +
        'positives to catch: the check exists in a helper the reviewer did not read; the endpoint is not actually\n' +
        'publicly reachable (see exposure model); .bind() IS used; the value is not actually attacker-controlled;\n' +
        'a downstream layer enforces it. If real, set the correct adjustedSeverity (downgrade hype). Quote the\n' +
        'exact code that confirms or refutes in "evidence".\n\n' +
        'EXPOSURE MODEL: only /oauth/token,/oauth/userinfo,/oauth/jwks,/.well-known/* are public; everything else\n' +
        'is proxied/service-binding reached.\n\n' +
        'FINDING (dimension ' + d.key + '):\n' + JSON.stringify(f, null, 2),
        { label: 'verify:' + d.key + ':' + f.file.split('/').pop(), phase: 'Verify', schema: VERDICT_SCHEMA },
      ).then((v) => ({ finding: f, verdict: v, dimension: d.key })).catch(() => null)
    ))
  },
)

const all = results.flat().filter(Boolean)
const confirmed = all.filter((r) => r.verdict && r.verdict.isReal && r.verdict.adjustedSeverity !== 'invalid')
const rejected = all.filter((r) => !(r.verdict && r.verdict.isReal && r.verdict.adjustedSeverity !== 'invalid'))

log('Confirmed ' + confirmed.length + ' of ' + all.length + ' candidate findings (' + rejected.length + ' refuted).')

const sevRank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
function rank(s) { return sevRank[s] === undefined ? 9 : sevRank[s] }
confirmed.sort((a, b) => rank(a.verdict.adjustedSeverity) - rank(b.verdict.adjustedSeverity))

const bySeverity = {}
for (const r of confirmed) {
  const s = r.verdict.adjustedSeverity
  bySeverity[s] = (bySeverity[s] || 0) + 1
}

return {
  summary: {
    candidates: all.length,
    confirmed: confirmed.length,
    refuted: rejected.length,
    bySeverity: bySeverity,
  },
  confirmed: confirmed.map((r) => ({
    severity: r.verdict.adjustedSeverity,
    title: r.finding.title,
    dimension: r.dimension,
    file: r.finding.file,
    line: r.finding.line,
    endpoint: r.finding.endpoint,
    exposure: r.finding.exposure,
    category: r.finding.category,
    description: r.finding.description,
    attack: r.finding.attack,
    recommendation: r.finding.recommendation,
    verifierReasoning: r.verdict.reasoning,
    evidence: r.verdict.evidence,
  })),
  refuted: rejected.map((r) => ({
    title: r.finding.title,
    file: r.finding.file,
    originalSeverity: r.finding.severity,
    whyRefuted: r.verdict ? r.verdict.reasoning : 'verifier error/null',
  })),
}
