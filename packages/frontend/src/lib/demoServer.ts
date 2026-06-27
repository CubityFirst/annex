// In-memory fake API for demo mode. installDemoServer() patches window.fetch
// so every /api/* request is answered from the local dataset below - the real
// Dashboard, FileManager, DocPage and WysiwygEditor run unmodified, and every
// "save" only mutates this module's state, which is gone on reload.
//
// Loaded via dynamic import from main.tsx only when the demo flag is set, so
// none of this ships on the normal boot path. The patch checks isDemoMode()
// per-request, so exiting demo (clearToken) immediately restores passthrough.
//
// Deliberate limits: exactly one site ("Demo Site") - site/org creation is
// refused; everything inside the site (docs, folders, files) is fully mutable.

import { isDemoMode, DEMO_USER_ID, DEMO_USER_NAME, DEMO_USER_EMAIL } from "./demo";

const PROJECT_ID = "demo-site";

interface DemoDoc {
  id: string;
  title: string;
  content: string;
  folder_id: string | null;
  updated_at: string;
  published_at: string | null;
  show_heading: number;
  show_last_updated: number;
  tags: string[];
}

interface DemoFolder {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
}

interface DemoFile {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  folder_id: string | null;
  created_at: string;
  blob: Blob;
}

interface DemoRevision {
  id: string;
  doc_id: string;
  editor_id: string;
  editor_name: string;
  created_at: string;
  changelog: string | null;
  contributors: string | null;
  content: string;
}

interface Store {
  projectName: string;
  projectDescription: string;
  isFavourite: number;
  isHidden: number;
  folders: DemoFolder[];
  docs: DemoDoc[];
  files: DemoFile[];
  revisions: DemoRevision[];
}

let store: Store | null = null;
let idCounter = 0;

function nextId(prefix: string): string {
  return `${prefix}-${++idCounter}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function minutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const FOLDER_GUIDES = "demo-folder-guides";
const DOC_WELCOME = "demo-doc-welcome";
const DOC_TOUR = "demo-doc-tour";
const DOC_COFFEE = "demo-doc-coffee";
const FILE_IMAGE = "demo-file-image";
const FILE_NOTES = "demo-file-notes";

const DEMO_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="420" viewBox="0 0 800 420">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1e1b4b"/>
      <stop offset="1" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect width="800" height="420" fill="url(#sky)"/>
  <circle cx="120" cy="80" r="2" fill="#e2e8f0"/>
  <circle cx="240" cy="50" r="1.5" fill="#cbd5e1"/>
  <circle cx="420" cy="90" r="2" fill="#e2e8f0"/>
  <circle cx="560" cy="40" r="1.5" fill="#cbd5e1"/>
  <circle cx="700" cy="110" r="2" fill="#e2e8f0"/>
  <circle cx="660" cy="80" r="26" fill="#fde68a" opacity="0.9"/>
  <!-- Annex wordmark (paths from public/annexwordmark.svg, viewBox 2226x424),
       scaled to ~420px wide and centred -->
  <g transform="translate(190,140) scale(0.18867)" fill="#e8e4de">
    <g transform="matrix(1,0,0,1,-611.45151,-2371.443353)">
      <g transform="matrix(1,0,0,1,0,449.94983)">
        <path d="M2449.091,2323.228L2520.837,2323.228L2645.565,2168.925L2756.693,2323.228L2837.008,2323.455L2695.235,2119.255L2836.52,1921.654L2757.047,1921.654L2645.669,2066.273L2527.46,1921.677L2455.713,1921.654L2591.479,2118.898L2449.091,2323.228Z"/>
      </g>
      <g transform="matrix(1,0,0,1,-3.368488,462.685578)">
        <path d="M2338.686,2198.024L2409.052,2198.024C2409.052,2198.024 2394.219,2326.777 2236.586,2330.478C2031.259,2335.299 2031.005,2122.138 2031.005,2122.138C2031.005,2122.138 2008.563,1935.69 2229.687,1909.659C2302.258,1901.116 2360.068,1955.854 2370.379,1965.82C2421.132,2014.874 2425.157,2144.912 2425.157,2144.912L2107.266,2144.912C2107.266,2144.912 2105.853,2261.392 2226.652,2264.218C2347.45,2267.043 2338.686,2198.024 2338.686,2198.024ZM2104.777,2083.837L2352.873,2083.837C2352.873,2083.837 2350.048,1975.33 2232.499,1973.635C2114.95,1971.939 2104.777,2083.837 2104.777,2083.837Z"/>
      </g>
      <g transform="matrix(1,0,0,1,463.504217,459.278706)">
        <path d="M1196.207,2090.042L1196.207,2321.213L1130.925,2321.213L1130.863,1931.037L1196.207,1931.037L1196.207,1988.007C1196.207,1988.007 1236.973,1911.558 1334.375,1912.407C1444.502,1913.367 1505.301,2004.328 1500.752,2056.264L1500.752,2321.213L1437.908,2321.213L1437.908,2089.269C1437.908,2089.269 1430.223,1976.824 1319.907,1977.145C1209.592,1977.466 1196.207,2090.042 1196.207,2090.042Z"/>
      </g>
      <g transform="matrix(1,0,0,1,-2.694791,459.203466)">
        <path d="M1196.207,2090.042L1196.207,2321.213L1130.925,2321.213L1130.863,1931.037L1196.207,1931.037L1196.207,1988.007C1196.207,1988.007 1236.973,1911.558 1334.375,1912.407C1444.502,1913.367 1504.882,2004.328 1500.333,2056.264L1500.752,2321.213L1437.908,2321.213L1437.908,2089.269C1437.908,2089.269 1430.223,1976.824 1319.907,1977.145C1209.592,1977.466 1196.207,2090.042 1196.207,2090.042Z"/>
      </g>
      <g transform="matrix(1,0,0,1,-0.867342,459.196446)">
        <path d="M974.495,1974.073L974.495,1928.835L1035.78,1928.693L1036.232,2320.759L974.495,2321.211L974.495,2265.769C968.742,2263.974 931.051,2341.441 804.028,2335.607C727.888,2332.11 604.613,2265.542 612.697,2109.244C620.782,1952.946 742.047,1909.829 828.281,1912.524C914.514,1915.219 974.495,1974.073 974.495,1974.073ZM824.05,1974.073C741.018,1974.073 673.606,2041.485 673.606,2124.518C673.606,2207.55 741.018,2274.962 824.05,2274.962C907.083,2274.962 974.495,2207.55 974.495,2124.518C974.495,2041.485 907.083,1974.073 824.05,1974.073Z"/>
      </g>
    </g>
  </g>
  <text x="400" y="300" text-anchor="middle" font-family="Georgia, serif" font-size="22" fill="#c7d2fe">An annex for your mind</text>
</svg>`;

const DEMO_NOTES_TXT = `Session zero planning notes
===========================

This is a plain demo file. In a real site you can upload images, audio,
PDFs and arbitrary attachments alongside your documents.

- Files live in the File Manager next to docs and folders
- Drag and drop uploads work too
- Images can be embedded in documents with standard markdown
`;

const WELCOME_CONTENT = `# Welcome to the Annex demo

This is a live, fully working copy of Annex. Everything you do here, from editing to creating docs and uploading files, stays inside the demo and is cleared when you leave.

> [!tip] Go ahead, break things
> Click the pencil icon in the top right to edit this document. Your changes will "save" and show up everywhere, but only inside this demo.

## What to try

- [x] Open the demo
- [ ] Edit this document (pencil icon, top right)
- [ ] Browse the **File Manager** from the sidebar
- [ ] Open the [[Editor tour]] for a feature walkthrough
- [ ] Press \`Ctrl+K\` and search for "coffee"
- [ ] Roll some dice: \`dice: 2d6+1d4 Try your luck\`

## The basics

| Feature | Where to find it |
| --- | --- |
| Documents | The File Manager, or the sidebar's recent list |
| WYSIWYG editing | Pencil icon on any document |
| Raw markdown mode | The \`</>\` toggle while editing |
| Full-text search | \`Ctrl+K\` anywhere in a site |
| Files & images | Upload via the File Manager |

Here's a sample image:

![demo-illustration.svg](/api/files/${FILE_IMAGE}/content)

## Ready for the real thing?

When you create your own Annex, everything here works the same, plus publishing, members and roles, realtime co-editing, document history, and more.
`;

const TOUR_CONTENT = `# Editor tour

Annex documents are markdown underneath, edited through a WYSIWYG editor (CodeMirror 6) that renders formatting inline as you type. Toggle raw markdown with the \`</>\` button while editing.

## Formatting

**Bold**, *italic*, __underline__, ~~strikethrough~~ and \`inline code\` all render live.

## Callouts

> [!note]
> Thirteen callout types, with aliases: note, tip, warning, danger, question, quote, and friends.

> [!warning] Foldable callouts
> Add \`+\` or \`-\` after the type to make a callout start open or closed.

## Code blocks

\`\`\`typescript
interface Doc {
  id: string;
  title: string;
  content: string; // markdown
}
\`\`\`

## Dice

Annex has a full dice-notation roller. Click any die to roll it:

- Standard: \`dice: 2d6+3\`
- Keep highest: \`dice: 4d6kh3\`
- Reroll ones: \`dice: 2d8r1\`
- Fate dice: \`dice: 4dF\`

## Wikilinks

Link documents by title with double brackets: [[Welcome to the Annex demo]] or with a label: [[Coffee brewing guide|see the brewing guide]].

## Images with attributes

![demo-illustration.svg](/api/files/${FILE_IMAGE}/content){width=320}

Width and height attributes in curly braces control sizing.
`;

const COFFEE_CONTENT = `---
tags: [sample, coffee]
---

# Coffee brewing guide

A sample doc. Annex is at home with anything structured: specs, runbooks, recipes, trip plans.

> [!quote] House rule
> "Weigh everything. Guessing is how you end up with sad coffee."

## Brew ratios

| Method | Coffee | Water | Time |
| --- | --- | --- | --- |
| V60 | 15 g | 250 g | 2:30 |
| French press | 30 g | 500 g | 4:00 |
| Aeropress | 17 g | 230 g | 1:30 |
| Cold brew | 60 g | 600 g | 12 h |

## Can't decide?

Let the dice pick today's brew: \`dice: 1d[V60,French press,Aeropress,Cold brew]\`

## Shopping list

- [x] Scale
- [x] Burr grinder
- [ ] Gooseneck kettle
- [ ] A second bag of beans (for emergencies)
`;

function seed(): Store {
  return {
    projectName: "Demo Site",
    projectDescription: "A sandbox site preloaded with sample docs and files. Poke around, nothing you do here is saved.",
    isFavourite: 1,
    isHidden: 0,
    folders: [
      { id: FOLDER_GUIDES, name: "Guides", parent_id: null, created_at: minutesAgo(60 * 24 * 3) },
    ],
    docs: [
      { id: DOC_WELCOME, title: "Welcome to the Annex demo", content: WELCOME_CONTENT, folder_id: null, updated_at: minutesAgo(90), published_at: null, show_heading: 0, show_last_updated: 1, tags: [] },
      { id: DOC_TOUR, title: "Editor tour", content: TOUR_CONTENT, folder_id: FOLDER_GUIDES, updated_at: minutesAgo(60 * 26), published_at: null, show_heading: 0, show_last_updated: 1, tags: [] },
      { id: DOC_COFFEE, title: "Coffee brewing guide", content: COFFEE_CONTENT, folder_id: null, updated_at: minutesAgo(60 * 49), published_at: null, show_heading: 0, show_last_updated: 1, tags: ["sample", "coffee"] },
    ],
    files: [
      { id: FILE_IMAGE, name: "demo-illustration.svg", mime_type: "image/svg+xml", size: DEMO_IMAGE_SVG.length, folder_id: null, created_at: minutesAgo(60 * 24 * 2), blob: new Blob([DEMO_IMAGE_SVG], { type: "image/svg+xml" }) },
      { id: FILE_NOTES, name: "session-zero-notes.txt", mime_type: "text/plain", size: DEMO_NOTES_TXT.length, folder_id: null, created_at: minutesAgo(60 * 24), blob: new Blob([DEMO_NOTES_TXT], { type: "text/plain" }) },
    ],
    revisions: [
      { id: "demo-rev-1", doc_id: DOC_WELCOME, editor_id: DEMO_USER_ID, editor_name: DEMO_USER_NAME, created_at: minutesAgo(60 * 24 * 2), changelog: "First draft", contributors: null, content: "# Welcome\n\nThis page is being written…" },
      { id: "demo-rev-2", doc_id: DOC_WELCOME, editor_id: DEMO_USER_ID, editor_name: DEMO_USER_NAME, created_at: minutesAgo(90), changelog: "Added the feature checklist and basics table", contributors: null, content: WELCOME_CONTENT },
    ],
  };
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ok(data?: unknown): Response {
  return json(data === undefined ? { ok: true } : { ok: true, data });
}

function notFound(error = "not_found"): Response {
  return json({ ok: false, error }, 404);
}

function blocked(error: string): Response {
  return json({ ok: false, error }, 400);
}

// ---------------------------------------------------------------------------
// Shapes the frontend expects
// ---------------------------------------------------------------------------

function projectListing(s: Store) {
  return {
    id: PROJECT_ID,
    name: s.projectName,
    description: s.projectDescription,
    doc_count: s.docs.length,
    member_count: 1,
    published_at: null,
    ai_enabled: 0,
    ai_summarization_type: "manual",
    is_favourite: s.isFavourite,
    is_hidden: s.isHidden,
    features: 0,
    organization_id: null,
    organization_name: null,
    role: "owner",
    published_graph_enabled: 0,
    graph_enabled: 0,
    changelog_mode: "off",
    home_doc_id: null,
    logo_square_updated_at: null,
    logo_wide_updated_at: null,
  };
}

function docListing(d: DemoDoc) {
  return {
    id: d.id,
    title: d.title,
    display_title: null,
    folder_id: d.folder_id,
    // The real API stores tags as a JSON-encoded array string - DocPage and
    // TagPage JSON.parse this field.
    tags: d.tags.length ? JSON.stringify(d.tags) : null,
    updated_at: d.updated_at,
    author_id: DEMO_USER_ID,
    author_name: DEMO_USER_NAME,
    author_role: "owner",
    is_home: 0,
  };
}

function docDetail(d: DemoDoc) {
  return {
    ...docListing(d),
    content: d.content,
    published_at: d.published_at,
    show_heading: d.show_heading,
    show_last_updated: d.show_last_updated,
    hide_title: null,
    myRole: "owner",
    myPermission: null,
    ai_summary: null,
    ai_summary_version: null,
  };
}

function folderListing(f: DemoFolder) {
  return { id: f.id, name: f.name, parent_id: f.parent_id, project_id: PROJECT_ID, created_at: f.created_at };
}

function fileListing(f: DemoFile) {
  return {
    id: f.id,
    name: f.name,
    mime_type: f.mime_type,
    size: f.size,
    project_id: PROJECT_ID,
    folder_id: f.folder_id,
    uploaded_by: DEMO_USER_ID,
    created_at: f.created_at,
    updated_at: f.created_at,
    uploader_name: DEMO_USER_NAME,
    uploader_role: "owner",
  };
}

function revisionMeta(r: DemoRevision) {
  return { id: r.id, editor_id: r.editor_id, editor_name: r.editor_name, created_at: r.created_at, changelog: r.changelog, contributors: r.contributors };
}

// ---------------------------------------------------------------------------
// Folder-tree helpers
// ---------------------------------------------------------------------------

function isInSubtree(s: Store, folderId: string | null, rootId: string): boolean {
  let current = folderId;
  while (current) {
    if (current === rootId) return true;
    current = s.folders.find(f => f.id === current)?.parent_id ?? null;
  }
  return false;
}

function ancestorsOf(s: Store, folderId: string | null): { id: string; name: string }[] {
  const chain: { id: string; name: string }[] = [];
  let current = folderId;
  while (current) {
    const folder = s.folders.find(f => f.id === current);
    if (!folder) break;
    chain.unshift({ id: folder.id, name: folder.name });
    current = folder.parent_id;
  }
  return chain;
}

function deleteFolderRecursive(s: Store, folderId: string): void {
  const childFolders = s.folders.filter(f => f.parent_id === folderId);
  for (const child of childFolders) deleteFolderRecursive(s, child.id);
  s.docs = s.docs.filter(d => d.folder_id !== folderId);
  s.files = s.files.filter(f => f.folder_id !== folderId);
  s.folders = s.folders.filter(f => f.id !== folderId);
}

// ---------------------------------------------------------------------------
// Request-body helpers
// ---------------------------------------------------------------------------

async function readJsonBody(input: RequestInfo | URL, init?: RequestInit): Promise<Record<string, unknown>> {
  try {
    if (typeof init?.body === "string") return JSON.parse(init.body) as Record<string, unknown>;
    if (input instanceof Request) return await input.clone().json() as Record<string, unknown>;
  } catch {
    // fall through
  }
  return {};
}

async function readFormBody(input: RequestInfo | URL, init?: RequestInit): Promise<FormData | null> {
  if (init?.body instanceof FormData) return init.body;
  if (input instanceof Request) {
    try {
      return await input.clone().formData();
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function buildExcerpt(content: string, term: string): string {
  const lower = content.toLowerCase();
  const idx = lower.indexOf(term.toLowerCase());
  if (idx === -1) return content.slice(0, 120);
  const start = Math.max(0, idx - 60);
  const end = Math.min(content.length, idx + term.length + 60);
  const before = content.slice(start, idx);
  const match = content.slice(idx, idx + term.length);
  const after = content.slice(idx + term.length, end);
  return `${start > 0 ? "…" : ""}${before}<mark>${match}</mark>${after}${end < content.length ? "…" : ""}`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

// Anonymous auth/public endpoints keep hitting the real network even while the
// demo flag is set - e.g. someone opening /login mid-demo should still be able
// to sign in for real (setToken exits demo mode).
const PASSTHROUGH_PREFIXES = [
  "/api/login",
  "/api/register",
  "/api/webauthn/",
  "/api/verify-email",
  "/api/force-change-password",
  "/api/public/",
  "/api/admin/",
  "/api/dev/",
];

async function route(method: string, url: URL, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const s = store ?? (store = seed());
  const seg = url.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);

  // --- session / user ---
  if (seg[0] === "me" && seg.length === 1 && method === "GET") {
    return ok({
      name: DEMO_USER_NAME,
      userId: DEMO_USER_ID,
      email: DEMO_USER_EMAIL,
      personalPlan: "free",
      personalPlanStyle: null,
      personalPresenceColor: null,
      personalCritSparkles: true,
      readingFont: null,
      editingFont: null,
      uiFont: null,
      isAdmin: false,
      themeMode: null,
      themeCustomColor: null,
      customThemingEnabled: false,
    });
  }
  if (seg[0] === "me" && seg[1] === "sessions" && seg[2] === "logout" && method === "POST") return ok();
  if (seg[0] === "users" && seg.length === 2 && method === "GET") {
    return ok({
      userId: seg[1],
      name: seg[1] === DEMO_USER_ID ? DEMO_USER_NAME : "Unknown",
      createdAt: minutesAgo(60 * 24 * 7),
      sharedProjects: [],
      favouriteSites: [],
      personalPlan: "free",
    });
  }

  // --- projects ---
  if (seg[0] === "projects" && seg.length === 1) {
    if (method === "GET") return ok([projectListing(s)]);
    if (method === "POST") return blocked("Site creation is disabled in the demo.");
  }
  if (seg[0] === "projects" && seg[1] === PROJECT_ID) {
    const sub = seg[2];
    if (!sub) {
      if (method === "GET") return ok(projectListing(s));
      if (method === "PUT") {
        const body = await readJsonBody(input, init);
        if (typeof body.name === "string" && body.name.trim()) s.projectName = body.name.trim();
        if (typeof body.description === "string") s.projectDescription = body.description;
        return ok(projectListing(s));
      }
    }
    if (sub === "favourite" && method === "PATCH") {
      s.isFavourite = s.isFavourite ? 0 : 1;
      if (s.isFavourite) s.isHidden = 0;
      return ok();
    }
    if (sub === "hidden" && method === "PATCH") {
      s.isHidden = s.isHidden ? 0 : 1;
      if (s.isHidden) s.isFavourite = 0;
      return ok();
    }
    if (sub === "contents" && method === "GET") {
      const folderId = url.searchParams.get("folderId");
      const folders = s.folders.filter(f => f.parent_id === folderId).map(folderListing);
      const docs = s.docs.filter(d => d.folder_id === folderId).map(docListing);
      const files = s.files.filter(f => f.folder_id === folderId).map(fileListing);
      const folderCounts: Record<string, { docs: number; folders: number }> = {};
      for (const f of folders) {
        folderCounts[f.id] = {
          docs: s.docs.filter(d => d.folder_id === f.id).length + s.files.filter(x => x.folder_id === f.id).length,
          folders: s.folders.filter(x => x.parent_id === f.id).length,
        };
      }
      return ok({ folders, docs, files, folderCounts, ancestors: ancestorsOf(s, folderId) });
    }
    if (sub === "members" && method === "GET") {
      return ok([{ userId: DEMO_USER_ID, name: DEMO_USER_NAME, email: DEMO_USER_EMAIL, role: "owner" }]);
    }
    if (sub === "api-keys" && method === "GET") return ok([]);
    if (sub === "invite-links" && method === "GET") return ok([]);
    if (sub === "graph" && method === "GET") return ok({ nodes: [], links: [] });
    if (sub === "api-keys" || sub === "invite-links" || sub === "domain" || sub === "logo" || sub === "folder-shares") {
      return method === "GET" ? notFound() : blocked("Not available in the demo.");
    }
  }

  // --- organizations / invites ---
  if (seg[0] === "organizations" && seg.length === 1) {
    if (method === "GET") return ok([]);
    if (method === "POST") return blocked("Organization creation is disabled in the demo.");
  }
  if (seg[0] === "pending-invites" && method === "GET") return ok([]);

  // --- docs ---
  if (seg[0] === "docs" && seg.length === 1) {
    if (method === "GET") {
      let docs = [...s.docs];
      const q = url.searchParams.get("q");
      const rootFolderId = url.searchParams.get("rootFolderId");
      if (rootFolderId) docs = docs.filter(d => isInSubtree(s, d.folder_id, rootFolderId));
      if (q) docs = docs.filter(d => d.title.toLowerCase().includes(q.toLowerCase()));
      return ok(docs.map(docListing));
    }
    if (method === "POST") {
      const body = await readJsonBody(input, init);
      const doc: DemoDoc = {
        id: nextId("demo-doc"),
        title: typeof body.title === "string" && body.title ? body.title : "Untitled",
        content: typeof body.content === "string" ? body.content : "",
        folder_id: typeof body.folderId === "string" ? body.folderId : null,
        updated_at: nowIso(),
        published_at: null,
        show_heading: 0,
        show_last_updated: 1,
        tags: [],
      };
      s.docs.push(doc);
      return ok(docDetail(doc));
    }
  }
  if (seg[0] === "docs" && seg.length >= 2) {
    const doc = s.docs.find(d => d.id === seg[1]);
    if (seg.length === 2) {
      if (!doc) return notFound();
      if (method === "GET") return ok(docDetail(doc));
      if (method === "PUT") {
        const body = await readJsonBody(input, init);
        if (typeof body.title === "string") doc.title = body.title;
        if ("folderId" in body) doc.folder_id = typeof body.folderId === "string" ? body.folderId : null;
        if ("publishedAt" in body) doc.published_at = typeof body.publishedAt === "string" ? body.publishedAt : null;
        if (typeof body.showLastUpdated === "boolean") doc.show_last_updated = body.showLastUpdated ? 1 : 0;
        if (typeof body.showHeading === "boolean") doc.show_heading = body.showHeading ? 1 : 0;
        if (typeof body.content === "string" && body.content !== doc.content) {
          doc.content = body.content;
          doc.updated_at = nowIso();
          s.revisions.push({
            id: nextId("demo-rev"),
            doc_id: doc.id,
            editor_id: DEMO_USER_ID,
            editor_name: DEMO_USER_NAME,
            created_at: doc.updated_at,
            changelog: typeof body.changelog === "string" && body.changelog ? body.changelog : null,
            contributors: null,
            content: doc.content,
          });
        }
        return ok(docDetail(doc));
      }
      if (method === "DELETE") {
        s.docs = s.docs.filter(d => d.id !== seg[1]);
        return ok();
      }
    }
    if (seg[2] === "revisions") {
      if (!doc) return notFound();
      const docRevisions = s.revisions.filter(r => r.doc_id === doc.id);
      if (seg.length === 3 && method === "GET") {
        return ok([...docRevisions].reverse().map(revisionMeta));
      }
      if (seg.length === 4 && method === "GET") {
        const rev = docRevisions.find(r => r.id === seg[3]);
        return rev ? ok({ ...revisionMeta(rev), content: rev.content }) : notFound();
      }
    }
    if (seg[2] === "shares" && method === "GET") return ok([]);
    if (seg[2] === "shares") return blocked("Sharing is not available in the demo.");
  }

  // --- folders ---
  if (seg[0] === "folders" && seg.length === 1) {
    if (method === "GET") return ok(s.folders.map(folderListing));
    if (method === "POST") {
      const body = await readJsonBody(input, init);
      const folder: DemoFolder = {
        id: nextId("demo-folder"),
        name: typeof body.name === "string" && body.name ? body.name : "New folder",
        parent_id: typeof body.parentId === "string" ? body.parentId : null,
        created_at: nowIso(),
      };
      s.folders.push(folder);
      return ok(folderListing(folder));
    }
  }
  if (seg[0] === "folders" && seg.length === 2) {
    const folder = s.folders.find(f => f.id === seg[1]);
    if (!folder) return notFound();
    if (method === "PUT") {
      const body = await readJsonBody(input, init);
      if (typeof body.name === "string" && body.name) folder.name = body.name;
      if ("parentId" in body) folder.parent_id = typeof body.parentId === "string" ? body.parentId : null;
      return ok(folderListing(folder));
    }
    if (method === "DELETE") {
      deleteFolderRecursive(s, folder.id);
      return ok();
    }
  }

  // --- files ---
  if (seg[0] === "files" && seg.length === 1 && method === "POST") {
    const form = await readFormBody(input, init);
    const file = form?.get("file");
    if (!(file instanceof File)) return blocked("No file in upload.");
    const folderId = form?.get("folderId");
    const record: DemoFile = {
      id: nextId("demo-file"),
      name: file.name || "untitled",
      mime_type: file.type || "application/octet-stream",
      size: file.size,
      folder_id: typeof folderId === "string" && folderId ? folderId : null,
      created_at: nowIso(),
      blob: file,
    };
    s.files.push(record);
    return ok(fileListing(record));
  }
  if (seg[0] === "files" && seg.length >= 2) {
    const file = s.files.find(f => f.id === seg[1]);
    if (!file) return notFound();
    if (seg.length === 2) {
      if (method === "GET") return ok(fileListing(file));
      if (method === "PUT") {
        const body = await readJsonBody(input, init);
        if (typeof body.name === "string" && body.name) file.name = body.name;
        if ("folderId" in body) file.folder_id = typeof body.folderId === "string" ? body.folderId : null;
        return ok(fileListing(file));
      }
      if (method === "DELETE") {
        s.files = s.files.filter(f => f.id !== seg[1]);
        return ok();
      }
    }
    if (seg[2] === "content" && method === "GET") {
      return new Response(file.blob, { status: 200, headers: { "Content-Type": file.mime_type } });
    }
    // Drawings save in place - overwrite the in-memory blob so a reopen shows the
    // edits (mirrors PUT /files/:id/content on the real API).
    if (seg[2] === "content" && method === "PUT") {
      const text = typeof init?.body === "string" ? init.body : "";
      file.blob = new Blob([text], { type: file.mime_type });
      file.size = file.blob.size;
      return ok({ id: file.id, size: file.size, updated_at: file.created_at });
    }
  }

  // --- search ---
  if (seg[0] === "search" && method === "GET") {
    const q = url.searchParams.get("q");
    const tag = url.searchParams.get("tag");
    if (tag) {
      const term = tag.toLowerCase();
      return ok(s.docs
        .filter(d => d.tags.some(t => t.toLowerCase().includes(term)))
        .map(d => ({ doc_id: d.id, title: d.title, tags: d.tags })));
    }
    const term = (q ?? "").trim();
    if (!term) return ok([]);
    return ok(s.docs
      .filter(d => d.title.toLowerCase().includes(term.toLowerCase()) || d.content.toLowerCase().includes(term.toLowerCase()))
      .map(d => ({ doc_id: d.id, title: d.title, excerpt: buildExcerpt(d.content, term) })));
  }

  // --- AI ---
  if (seg[0] === "ai" && seg[1] === "summarize" && method === "POST") {
    return ok({ summary: "AI summaries aren't available in the demo. In a real site this is a generated summary of the document." });
  }

  return notFound("not_available_in_demo");
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

let installed = false;

export function installDemoServer(): void {
  if (installed) return;
  installed = true;
  store = seed();

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isDemoMode()) return realFetch(input, init);
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) {
      return realFetch(input, init);
    }
    if (PASSTHROUGH_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) {
      return realFetch(input, init);
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    try {
      return await route(method, url, input, init);
    } catch {
      return json({ ok: false, error: "demo_error" }, 500);
    }
  };
}
