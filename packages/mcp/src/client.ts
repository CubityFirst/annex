// Minimal client for the Annex public API (/v1). One instance serves every key;
// the key is passed per call, so a request can only ever act on the site that
// key is bound to (the server takes the site from the key, never the URL).

export type Role = "limited" | "viewer" | "editor" | "admin" | "owner";

export interface KeyInfo {
  id: string;
  name: string;
  keyPrefix: string;
  scope: "read" | "readwrite";
  canInvite: boolean;
  createdAt: string;
  expiresAt: string | null;
  role: Role;
  site: { id: string; name: string; vanitySlug: string | null };
}

export interface DocSummary {
  id: string;
  slug: string | null;
  title: string;
  folderId: string | null;
  publishedAt: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Doc extends DocSummary {
  content: string;
}

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: Role;
  accepted: boolean;
  createdAt: string;
}

export class AnnexApiError extends Error {
  constructor(readonly status: number, readonly serverMessage: string) {
    super(describeStatus(status, serverMessage));
  }
}

function describeStatus(status: number, serverMessage: string): string {
  switch (status) {
    case 401: return "The API key was rejected (invalid, revoked or expired).";
    case 403: return "Forbidden: the key's scope, or its owner's current role on the site, does not allow this.";
    case 404: return "Not found (or not visible to this key).";
    case 409: return "Conflict: " + serverMessage;
    case 429: return "Rate limited by Annex (120 requests/minute per key). Try again shortly.";
    case 503: return "The Annex public API is temporarily disabled.";
    default: return `Annex API error ${status}: ${serverMessage}`;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 30_000;

export class AnnexClient {
  constructor(
    private readonly apiUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly userAgent = "annex-mcp",
  ) {}

  private async request<T>(secret: string, method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiUrl}/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${secret}`,
          Accept: "application/json",
          "User-Agent": this.userAgent,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Could not reach Annex at ${this.apiUrl}: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: T; error?: string } | null;
    if (!res.ok || !json || json.ok !== true) {
      throw new AnnexApiError(res.status, json?.error ?? res.statusText ?? "unknown error");
    }
    return json.data as T;
  }

  keyInfo(secret: string) { return this.request<KeyInfo>(secret, "GET", "/key"); }
  revokeKey(secret: string) { return this.request<{ revoked: true }>(secret, "DELETE", "/key"); }

  listDocs(secret: string) { return this.request<DocSummary[]>(secret, "GET", "/docs"); }
  getDoc(secret: string, id: string) { return this.request<Doc>(secret, "GET", `/docs/${encodeURIComponent(id)}`); }
  createDoc(secret: string, body: { title: string; content?: string; folderId?: string | null }) {
    return this.request<DocSummary>(secret, "POST", "/docs", body);
  }
  updateDoc(
    secret: string,
    id: string,
    body: { title?: string; content?: string; folderId?: string | null; published?: boolean },
  ) {
    return this.request<DocSummary & { content?: string }>(secret, "PATCH", `/docs/${encodeURIComponent(id)}`, body);
  }
  deleteDoc(secret: string, id: string) {
    return this.request<{ deleted: true }>(secret, "DELETE", `/docs/${encodeURIComponent(id)}`);
  }

  listMembers(secret: string) { return this.request<Member[]>(secret, "GET", "/members"); }
  inviteMember(secret: string, body: { email: string; role: Exclude<Role, "owner"> }) {
    return this.request<Member>(secret, "POST", "/members", body);
  }
  removeMember(secret: string, userId: string) {
    return this.request<{ deleted: true }>(secret, "DELETE", `/members/${encodeURIComponent(userId)}`);
  }
}
