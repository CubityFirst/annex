import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ClipboardCopy, Copy, KeyRound, Plus, Power, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  type CreatedOAuthClient,
  type OAuthClient,
  createOAuthClient,
  deleteOAuthClient,
  listOAuthClients,
  rotateOAuthClientSecret,
  setOAuthClientDisabled,
} from "@/lib/api";

const DISCOVERY_URL = "https://auth.cubityfir.st/.well-known/openid-configuration";

async function copy(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Couldn't copy to clipboard");
  }
}

// Build the ready-to-paste brief for the connected service's coding agent, with
// this client's details filled in. `secret` is only available right after
// create/rotate; for an existing client it's omitted and the prompt points the
// operator at "rotate" to mint a fresh one.
function buildAgentPrompt(opts: {
  clientId: string;
  redirectUris: string[];
  scopes: string;
  isPublic: boolean;
  secret?: string | null;
}): string {
  const secretLine = opts.isPublic
    ? "client_secret: (none — public client, PKCE only)"
    : opts.secret
      ? `client_secret: ${opts.secret}`
      : "client_secret: <rotate this client in the Annex admin to mint a fresh secret>";
  const primaryRedirect = opts.redirectUris[0] ?? "<YOUR_EXACT_CALLBACK_URL>";
  const extraRedirects =
    opts.redirectUris.length > 1 ? `\n                 (also registered: ${opts.redirectUris.slice(1).join(", ")})` : "";
  const hasRoles = opts.scopes.split(/\s+/).includes("roles");
  const rolesClaim = hasRoles ? `, roles (string array, e.g. ["admin"])` : "";
  const rolesRequirement = hasRoles
    ? `\n8. The id_token/userinfo include a "roles" array. Gate admin-only features
   on roles.includes("admin") — do NOT hardcode a user id/email for admin.`
    : "";

  return `Add "Sign in with Annex" to this project. Annex is a standard OpenID Connect
(OIDC) provider — use a well-maintained OIDC client library for this stack, not
a hand-rolled flow.

PROVIDER (everything else is discoverable):
- Issuer:        https://auth.cubityfir.st
- Discovery:     ${DISCOVERY_URL}
- Flow:          Authorization Code + PKCE (S256). id_tokens are RS256; verify
                 offline via the provider's JWKS (in the discovery doc).
- Scopes:        ${opts.scopes}
- Claims you get: sub (stable unique user id — key your users on THIS, never on
                  email), email, email_verified, name${rolesClaim}.

CREDENTIALS (store the secret server-side only — never ship it to the browser):
- client_id:     ${opts.clientId}
- ${secretLine}
- redirect_uri:  ${primaryRedirect}${extraRedirects}

REQUIREMENTS:
1. Configure the OIDC client from the discovery URL — do NOT hardcode the
   endpoints (the authorization endpoint is on a different host than the issuer;
   discovery handles that for you).
2. Authorization Code flow with PKCE (code_challenge_method=S256).
3. Send and verify state (CSRF) and a nonce (bound into the id_token).
4. Request scope "${opts.scopes}".
5. On callback: exchange the code at the token endpoint (send the PKCE
   code_verifier; include the client_secret only for a confidential/server-side
   client), then VERIFY the id_token: signature against JWKS, plus the iss, aud
   (== client_id), exp, and nonce claims. Most OIDC libraries do this for you —
   make sure it's enabled, not skipped.
6. Establish your app's own session from the verified identity; key users on sub.
7. The redirect_uri must match what's registered with Annex byte-for-byte
   (scheme, host, port, path). If you change it, tell me so it can be updated.${rolesRequirement}

Use the right library for the stack (Auth.js/NextAuth custom "oidc" provider,
Node openid-client, Python authlib, Go coreos/go-oidc, or any conformant
OIDC+PKCE client) pointed at the discovery URL. Add a "Sign in with Annex"
button, store the secret in the project's secret manager, and verify end-to-end:
sign in and show me the verified claims you receive.`;
}

// Compact field with a copy button — used in the credentials dialog.
function CopyField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <code className={`flex-1 truncate rounded-md border bg-muted/40 px-2 py-1 text-xs ${mono ? "font-mono" : ""}`}>
          {value}
        </code>
        <Button size="icon" variant="outline" className="h-7 w-7 shrink-0" onClick={() => void copy(value, label)}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

interface CredentialsState {
  title: string;
  clientId: string;
  secret: string | null;
  redirectUris: string[];
  scopes: string;
  isPublic: boolean;
}

function RegisterForm({ onCreated }: { onCreated: (c: CreatedOAuthClient) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [redirects, setRedirects] = useState("");
  const [scopeProfile, setScopeProfile] = useState(true);
  const [scopeEmail, setScopeEmail] = useState(true);
  const [scopeRoles, setScopeRoles] = useState(false);
  const [trusted, setTrusted] = useState(true);
  const [isPublic, setIsPublic] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setName("");
    setRedirects("");
    setScopeProfile(true);
    setScopeEmail(true);
    setScopeRoles(false);
    setTrusted(true);
    setIsPublic(false);
  }

  async function submit() {
    const redirect_uris = redirects.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!name.trim() || redirect_uris.length === 0) {
      toast.error("A name and at least one redirect URI are required");
      return;
    }
    const scopes = ["openid", scopeProfile ? "profile" : "", scopeEmail ? "email" : "", scopeRoles ? "roles" : ""]
      .filter(Boolean)
      .join(" ");
    setSubmitting(true);
    try {
      const created = await createOAuthClient({ name: name.trim(), redirect_uris, scopes, trusted, public: isPublic });
      setOpen(false);
      reset();
      onCreated(created);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to register client");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4" />
          Register client
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Register a "Sign in with Annex" client</SheetTitle>
          <SheetDescription>
            Creates an OIDC client. The secret is shown once on creation.
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="oauth-name">Service name</Label>
            <Input id="oauth-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Dashboard" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="oauth-redirects">Redirect URIs (one per line)</Label>
            <Textarea
              id="oauth-redirects"
              value={redirects}
              onChange={(e) => setRedirects(e.target.value)}
              placeholder={"https://app.example.com/api/auth/callback/annex"}
              rows={3}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Matched exactly — include scheme, host, port, and path. https only (localhost allowed for dev).
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Scopes</Label>
            <div className="flex items-center gap-2">
              <Checkbox id="scope-openid" checked disabled />
              <Label htmlFor="scope-openid" className="font-normal text-muted-foreground">openid (required)</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="scope-profile" checked={scopeProfile} onCheckedChange={(v) => setScopeProfile(v === true)} />
              <Label htmlFor="scope-profile" className="font-normal">profile (name)</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="scope-email" checked={scopeEmail} onCheckedChange={(v) => setScopeEmail(v === true)} />
              <Label htmlFor="scope-email" className="font-normal">email (email, email_verified)</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="scope-roles" checked={scopeRoles} onCheckedChange={(v) => setScopeRoles(v === true)} />
              <Label htmlFor="scope-roles" className="font-normal">roles (admin gating — adds roles: ["admin"] for Annex admins)</Label>
            </div>
          </div>

          <div className="flex items-start gap-2">
            <Checkbox id="oauth-trusted" checked={trusted} onCheckedChange={(v) => setTrusted(v === true)} className="mt-0.5" />
            <div>
              <Label htmlFor="oauth-trusted" className="font-normal">Trusted (auto-approve)</Label>
              <p className="text-xs text-muted-foreground">Skip the consent screen — use for first-party services you run.</p>
            </div>
          </div>

          <div className="flex items-start gap-2">
            <Checkbox id="oauth-public" checked={isPublic} onCheckedChange={(v) => setIsPublic(v === true)} className="mt-0.5" />
            <div>
              <Label htmlFor="oauth-public" className="font-normal">Public client (no secret)</Label>
              <p className="text-xs text-muted-foreground">For SPA / native apps that use PKCE only. Leave off for server-side apps.</p>
            </div>
          </div>
        </SheetBody>
        <SheetFooter>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting ? "Registering…" : "Register"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export function OAuthClientsPage() {
  const [clients, setClients] = useState<OAuthClient[] | null>(null);
  const [credentials, setCredentials] = useState<CredentialsState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OAuthClient | null>(null);
  const [rotateTarget, setRotateTarget] = useState<OAuthClient | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await listOAuthClients(signal);
      setClients(list);
    } catch (err) {
      if (!signal?.aborted) toast.error(err instanceof Error ? err.message : "Failed to load clients");
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  function onCreated(c: CreatedOAuthClient) {
    setCredentials({
      title: "Client registered",
      clientId: c.client_id,
      secret: c.client_secret,
      redirectUris: c.redirect_uris,
      scopes: c.allowed_scopes,
      isPublic: c.is_public,
    });
    void load();
  }

  async function toggleDisabled(client: OAuthClient) {
    try {
      await setOAuthClientDisabled(client.client_id, !client.disabled);
      toast.success(client.disabled ? "Client enabled" : "Client disabled");
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update client");
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      await deleteOAuthClient(target.client_id);
      toast.success(`Deleted ${target.client_name}`);
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete client");
    }
  }

  async function confirmRotate() {
    if (!rotateTarget) return;
    const target = rotateTarget;
    setRotateTarget(null);
    try {
      const secret = await rotateOAuthClientSecret(target.client_id);
      setCredentials({
        title: "New secret generated",
        clientId: target.client_id,
        secret,
        redirectUris: target.redirect_uris,
        scopes: target.allowed_scopes,
        isPublic: target.is_public,
      });
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rotate secret");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <KeyRound className="h-5 w-5" />
            Sign in with Annex
          </h1>
          <p className="text-sm text-muted-foreground">
            OIDC clients that can authenticate users against their Annex account.
          </p>
        </div>
        <RegisterForm onCreated={onCreated} />
      </div>

      <Card>
        <CardContent className="p-0">
          {clients === null ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : clients.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              No clients yet. Register one to add a "Sign in with Annex" button to another service.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Client ID</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Redirect URIs</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clients.map((client) => (
                  <TableRow key={client.client_id} className={client.disabled ? "opacity-60" : ""}>
                    <TableCell className="font-medium">
                      {client.client_name}
                      <div className="mt-1 flex gap-1">
                        {client.trusted && <Badge variant="secondary" className="text-[10px]">trusted</Badge>}
                        <Badge variant="outline" className="text-[10px]">{client.allowed_scopes}</Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <button
                        className="font-mono text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => void copy(client.client_id, "Client ID")}
                        title="Copy client ID"
                      >
                        {client.client_id}
                      </button>
                    </TableCell>
                    <TableCell>
                      <Badge variant={client.is_public ? "outline" : "secondary"}>
                        {client.is_public ? "public" : "confidential"}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[240px]">
                      <div className="flex flex-col gap-0.5">
                        {client.redirect_uris.map((u) => (
                          <span key={u} className="truncate font-mono text-xs text-muted-foreground" title={u}>{u}</span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={client.disabled ? "outline" : "secondary"}>
                        {client.disabled ? "disabled" : "active"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          title="Copy agent prompt"
                          onClick={() =>
                            void copy(
                              buildAgentPrompt({
                                clientId: client.client_id,
                                redirectUris: client.redirect_uris,
                                scopes: client.allowed_scopes,
                                isPublic: client.is_public,
                              }),
                              "Agent prompt",
                            )
                          }
                        >
                          <ClipboardCopy className="h-4 w-4" />
                        </Button>
                        {!client.is_public && (
                          <Button size="icon" variant="ghost" className="h-8 w-8" title="Rotate secret" onClick={() => setRotateTarget(client)}>
                            <RotateCw className="h-4 w-4" />
                          </Button>
                        )}
                        <Button size="icon" variant="ghost" className="h-8 w-8" title={client.disabled ? "Enable" : "Disable"} onClick={() => void toggleDisabled(client)}>
                          <Power className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" title="Delete" onClick={() => setDeleteTarget(client)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Credentials shown once (on create / rotate) */}
      <Dialog open={credentials !== null} onOpenChange={(o) => !o && setCredentials(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{credentials?.title}</DialogTitle>
            <DialogDescription>
              Copy the secret now — it can't be shown again. Store it in the connected service's config.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <CopyField label="Client ID" value={credentials?.clientId ?? ""} />
            {credentials?.secret ? (
              <CopyField label="Client secret (shown once)" value={credentials.secret} />
            ) : (
              <p className="text-xs text-muted-foreground">Public client — no secret (PKCE only).</p>
            )}
            <CopyField label="Discovery URL (give this to the service)" value={DISCOVERY_URL} mono={false} />
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              variant="outline"
              onClick={() =>
                credentials &&
                void copy(
                  buildAgentPrompt({
                    clientId: credentials.clientId,
                    redirectUris: credentials.redirectUris,
                    scopes: credentials.scopes,
                    isPublic: credentials.isPublic,
                    secret: credentials.secret,
                  }),
                  "Agent prompt",
                )
              }
            >
              <ClipboardCopy className="h-4 w-4" />
              Copy for agents
            </Button>
            <Button onClick={() => setCredentials(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.client_name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the client. Any service still using it will immediately fail to sign users in.
              Consider disabling instead if you might re-enable it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rotate confirm */}
      <AlertDialog open={rotateTarget !== null} onOpenChange={(o) => !o && setRotateTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate secret for {rotateTarget?.client_name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The current secret stops working immediately. You'll get a new secret to paste into the service.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmRotate()}>Rotate</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
