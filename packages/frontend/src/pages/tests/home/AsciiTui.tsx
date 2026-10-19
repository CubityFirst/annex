import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { roll } from "@/lib/dice";
import { AnnexLogo } from "@/components/AnnexLogo";
import shotEdit from "@/assets/landing/editor.webp";
import shotPublish from "@/assets/landing/publish.webp";
import { MONO, runLoop, prefersReducedMotion } from "./ascii";
import { TreatedImage } from "./TreatedImage";

// The landing page as a terminal app: a file tree, a content pane that
// types each "file" out, a live activity log and a spinning ASCII cube.
// vim-ish keys: j/k (or arrows) move, enter/l opens, 1-9 jump, ":" opens
// the command line (:demo, :signup, :login, :roll 2d6, :open <file>, :q).
// Everything is real DOM - headings, links, buttons - styled as text.

type File = { name: string; body?: string; image?: { src: string; alt: string } };

const FILES: File[] = [
  {
    name: "README.md",
    body: `# A place to keep anything.
Annex is a calm docs workspace. Write in markdown, keep your files and drawings alongside, and publish any of it to the web when you're ready.

- [x] free to use, no card required
- [x] every feature on every account
- [ ] you, here, writing something

[create your annex](/register)  [try the demo](/demo)  [login](/login)

> tip: press j / k to move, enter to open, : for commands.`,
  },
  {
    name: "write.md",
    body: `# Markdown underneath. Nothing in the way.
Annex renders your markdown as you type, so you get a clean page without giving up plain text. Flip to raw mode any time.

## what you get
- callouts, tables, code blocks and task lists
- wikilinks, tags and a live outline for long docs
- inline dice rolls like 2d6+1d4, right in the text

\`\`\`
> [!tip] House rule
> Weigh everything.
\`\`\``,
  },
  { name: "editor.png", image: { src: shotEdit, alt: "The Annex editor showing formatting, callouts and a code block" } },
  {
    name: "organise.md",
    body: `# Your files live next to your words.
Upload images, audio, video, PDFs and text, then preview them inline. Sketch on a built-in Excalidraw canvas without leaving the site.

- folders for docs, uploads and drawings together
- uploads up to 50 MB with in-browser previews
- a recycle bin, because everyone deletes the wrong folder once`,
  },
  {
    name: "publish.md",
    body: `# Publish it when you're ready.
Any site can become a public website with navigation, search and link previews. Keep it private until it's ready, then switch it on.

- one switch to publish a whole site
- friendly doc urls from a slug: in the frontmatter
- your own domain for published sites (early access)`,
  },
  { name: "publish.png", image: { src: shotPublish, alt: "A published Annex site in its public reading view" } },
  {
    name: "everything-else.md",
    body: `# And everything else a docs site should do.
- version history: every save kept, restore in a click
- search: ctrl+k across titles and full text
- tags & graph: see how everything links together
- organizations: roles trickle down to every site
- rest api: scoped keys for your own tools
- export: a zip of plain .md files, any time
- live collaboration and ai summaries (early access)`,
  },
  {
    name: "pricing.md",
    body: `# Free. Ink is optional.
There's no paywall and no missing buttons.

## annex - $0 / month
The whole product, for everyone.

## annex ink - $5 / month
Everything in Annex, plus quietly fancy cosmetics: an animated avatar ring, a custom collab cursor colour, a sparkle by your name, and sparkles when your dice crit.

[become a supporter](/register)`,
  },
  {
    name: "faq.md",
    body: `# Questions
## is annex really free?
Yes. Ink only adds cosmetic touches.

## can i get my data out?
Docs are markdown. Export a whole site as a zip whenever you like.

## can i try it first?
[the demo](/demo) is a full copy of Annex that runs in your browser. Nothing is saved, so break things.`,
  },
];

const ACTIVITY = [
  "saved revision 14 of coffee-brewing-guide.md",
  "mira joined session-12.md",
  "rolled 1d20+5 = 17 in session-12.md",
  "uploaded roadmap.excalidraw (212 KB)",
  "published demo-site",
  "tagged french-press.md #coffee",
  "restored runbook-deploy.md from revision 3",
  "exported demo-site as markdown (41 files)",
  "linked [[cold-brew]] from coffee-brewing-guide.md",
];

const CHARS_PER_SEC = 900;

/* ── markdown-as-terminal renderer ── */

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0, m: RegExpExecArray | null, n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <Link key={`${key}-${n++}`} className="tui-link" to={m[2]}>[{m[1]}]</Link>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ src }: { src: string }) {
  const lines = src.split("\n");
  const out: ReactNode[] = [];
  let code: string[] | null = null;
  lines.forEach((line, i) => {
    const key = `l${i}`;
    if (line.startsWith("```")) {
      if (code) {
        out.push(<pre key={key} className="tui-code">{code.join("\n")}</pre>);
        code = null;
      } else code = [];
      return;
    }
    if (code) { code.push(line); return; }
    if (line.startsWith("# ")) out.push(<h1 key={key} className="tui-h1"><span aria-hidden="true"># </span>{line.slice(2)}</h1>);
    else if (line.startsWith("## ")) out.push(<h2 key={key} className="tui-h2"><span aria-hidden="true">## </span>{line.slice(3)}</h2>);
    else if (line.startsWith("> ")) out.push(<p key={key} className="tui-quote">│ {inline(line.slice(2), key)}</p>);
    else if (/^- \[[ x]\] /.test(line)) out.push(<p key={key} className="tui-li"><span className="tui-box">{line[3] === "x" ? "[x]" : "[ ]"}</span> {inline(line.slice(6), key)}</p>);
    else if (line.startsWith("- ")) out.push(<p key={key} className="tui-li"><span className="tui-dim">-</span> {inline(line.slice(2), key)}</p>);
    else if (line.trim() === "") out.push(<p key={key} className="tui-gap" aria-hidden="true" />);
    else out.push(<p key={key}>{inline(line, key)}</p>);
  });
  if (code) out.push(<pre key="open-code" className="tui-code">{(code as string[]).join("\n")}</pre>);
  return <>{out}</>;
}

/* ── donut.c-style spinning cube ── */

function AsciiCube() {
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = pre.current;
    if (!el) return;
    const W = 34, H = 16, RAMP = ".,-~:;=!*#$@";
    const render = (t: number) => {
      const A = t * 0.7, B = t * 0.45, C = t * 0.3;
      const out = new Array(W * H).fill(" ");
      const zb = new Float32Array(W * H);
      const sa = Math.sin(A), ca = Math.cos(A), sb = Math.sin(B), cb = Math.cos(B), sc = Math.sin(C), cc = Math.cos(C);
      const rot = (x: number, y: number, z: number) => {
        let y1 = y * ca - z * sa, z1 = y * sa + z * ca;
        const x1 = x * cb + z1 * sb; z1 = -x * sb + z1 * cb;
        const x2 = x1 * cc - y1 * sc; y1 = x1 * sc + y1 * cc;
        return [x2, y1, z1] as const;
      };
      const L = [0.4, 0.7, -0.6];
      const ln = Math.hypot(...L);
      const faces: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      for (const [nx, ny, nz] of faces) {
        const [rnx, rny, rnz] = rot(nx, ny, nz);
        const lum = (rnx * L[0] + rny * L[1] + rnz * L[2]) / ln;
        for (let a = -1; a <= 1; a += 0.07)
          for (let b = -1; b <= 1; b += 0.07) {
            const p = nx ? [nx, a, b] : ny ? [a, ny, b] : [a, b, nz];
            const [x, y, z] = rot(p[0], p[1], p[2]);
            const ooz = 1 / (z + 4.2);
            const xp = Math.floor(W / 2 + 30 * ooz * x);
            const yp = Math.floor(H / 2 - 15 * ooz * y);
            if (xp < 0 || yp < 0 || xp >= W || yp >= H) continue;
            const idx = xp + yp * W;
            if (ooz > zb[idx]) {
              zb[idx] = ooz;
              // Edges read as solid ridges.
              const edge = Math.abs(a) > 0.93 || Math.abs(b) > 0.93;
              out[idx] = edge ? "#" : RAMP[Math.max(0, Math.min(RAMP.length - 1, Math.floor((lum + 0.2) * 8)))];
            }
          }
      }
      let s = "";
      for (let y = 0; y < H; y++) s += out.slice(y * W, y * W + W).join("") + "\n";
      el.textContent = s;
    };
    if (prefersReducedMotion()) { render(1.1); return; }
    return runLoop(el, 24, render);
  }, []);
  return <pre ref={pre} className="tui-cube" aria-hidden="true" />;
}

/* ── shell ── */

function Pane({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <section className={`tui-pane ${className ?? ""}`} aria-label={title}>
      <span className="tui-pane-title" aria-hidden="true">┤ {title} ├</span>
      <div className="tui-pane-body">{children}</div>
    </section>
  );
}

export function AsciiTui({ isLoggedIn }: { isLoggedIn: boolean }) {
  const navigate = useNavigate();
  const [sel, setSel] = useState(0);
  const selRef = useRef(0);
  selRef.current = sel;
  const [open, setOpen] = useState(0);
  const [typed, setTyped] = useState(0);
  const [opens, setOpens] = useState(0);
  const [cmd, setCmd] = useState<string | null>(null);
  const [log, setLog] = useState<{ id: number; text: string; kind?: "cmd" | "err" }[]>([]);
  const logId = useRef(0);
  const cmdInput = useRef<HTMLInputElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const body = FILES[open].body ?? "";

  const pushLog = useCallback((text: string, kind?: "cmd" | "err") => {
    setLog((l) => [...l.slice(-11), { id: logId.current++, text, kind }]);
  }, []);

  const openFile = useCallback((i: number) => {
    setSel(i);
    setOpen(i);
    setTyped(prefersReducedMotion() ? Infinity : 0);
    setOpens((n) => n + 1);
  }, []);

  // Type the open file out.
  useEffect(() => {
    if (typed >= body.length) return;
    let raf = 0, last = performance.now();
    const step = (now: number) => {
      const add = Math.max(1, Math.round(((now - last) / 1000) * CHARS_PER_SEC));
      last = now;
      setTyped((t) => {
        const next = Math.min(body.length, t + add);
        if (next < body.length) raf = requestAnimationFrame(step);
        return next;
      });
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [opens, body.length]);

  // Ambient activity feed.
  useEffect(() => {
    let i = 0;
    pushLog("annex v1 ready - type : for commands");
    const id = window.setInterval(() => pushLog(ACTIVITY[i++ % ACTIVITY.length]), 2600);
    return () => window.clearInterval(id);
  }, [pushLog]);

  // Global vim-ish keys (ignored while typing in an input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(FILES.length - 1, s + 1)); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
      else if (e.key === "Enter" || e.key === "l") {
        if (t.closest("a, button") && e.key === "Enter") return;
        e.preventDefault();
        openFile(selRef.current);
      }
      else if (/^[1-9]$/.test(e.key) && Number(e.key) <= FILES.length) openFile(Number(e.key) - 1);
      else if (e.key === ":") { e.preventDefault(); setCmd(""); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openFile]);

  useEffect(() => { if (cmd === "") cmdInput.current?.focus(); }, [cmd]);
  useEffect(() => { items.current[sel]?.scrollIntoView({ block: "nearest" }); }, [sel]);

  const run = (e: FormEvent) => {
    e.preventDefault();
    const raw = (cmd ?? "").trim().replace(/^:/, "");
    setCmd(null);
    if (!raw) return;
    pushLog(`:${raw}`, "cmd");
    const [name, ...rest] = raw.split(/\s+/);
    const arg = rest.join(" ");
    const go = (to: string) => { pushLog(`opening ${to} ...`); window.setTimeout(() => navigate(to), 350); };
    switch (name) {
      case "q": case "q!": case "quit": case "wq": pushLog("you can't quit. it's free."); break;
      case "demo": go("/demo"); break;
      case "signup": case "register": go("/register"); break;
      case "login": go(isLoggedIn ? "/dashboard" : "/login"); break;
      case "help": pushLog("j/k move · enter open · 1-9 jump · :demo :signup :login :roll <dice> :open <file> :q"); break;
      case "roll": {
        try {
          const r = roll(arg || "1d20");
          pushLog(`rolled ${arg || "1d20"} = ${r.total}`);
        } catch {
          pushLog(`E: can't roll "${arg}"`, "err");
        }
        break;
      }
      case "open": case "e": {
        const i = FILES.findIndex((f) => f.name === arg || f.name.startsWith(arg));
        if (i >= 0) openFile(i); else pushLog(`E: no such file: ${arg}`, "err");
        break;
      }
      default: pushLog(`E492: Not an editor command: ${raw}`, "err");
    }
  };

  const file = FILES[open];
  const visible = useMemo(() => body.slice(0, typed), [body, typed]);
  const done = typed >= body.length;

  return (
    <div className="tui">
      <header className="tui-top">
        <Link to="/" aria-label="Annex home" className="tui-logo"><AnnexLogo height={16} /></Link>
        <span className="tui-dim tui-path">~/annex/{file.name}</span>
        <nav className="tui-actions" aria-label="Account">
          {!isLoggedIn && <Link to="/login">[ login ]</Link>}
          <Link className="tui-cta" to={isLoggedIn ? "/dashboard" : "/register"}>{isLoggedIn ? "[ dashboard ]" : "[ get started ]"}</Link>
        </nav>
      </header>

      <div className="tui-body">
        <Pane title="files" className="tui-files">
          <ul role="list">
            {FILES.map((f, i) => (
              <li key={f.name}>
                <button
                  ref={(el) => { items.current[i] = el; }}
                  type="button"
                  className={`tui-file${i === sel ? " is-sel" : ""}`}
                  aria-current={i === open ? "page" : undefined}
                  onClick={() => openFile(i)}
                >
                  <span className="tui-dim">{i + 1}</span> {i === open ? "▸" : " "} {f.name}
                </button>
              </li>
            ))}
          </ul>
        </Pane>

        <Pane title={file.name} className="tui-main">
          <article className="tui-doc" key={file.name}>
            {file.image ? (
              <TreatedImage src={file.image.src} alt={file.image.alt} treatment="ascii" palette={["#0b0b0b", ...MONO.slice(1)]} />
            ) : (
              <>
                <Markdown src={visible} />
                {!done && <span className="tui-caret" aria-hidden="true">█</span>}
              </>
            )}
          </article>
        </Pane>

        <div className="tui-side">
          <Pane title="cube" className="tui-cube-pane"><AsciiCube /></Pane>
          <Pane title="log" className="tui-log">
            <ol aria-live="polite">
              {log.map((l) => (
                <li key={l.id} className={l.kind ? `tui-log-${l.kind}` : undefined}>{l.text}</li>
              ))}
            </ol>
          </Pane>
        </div>
      </div>

      <footer className="tui-status">
        {cmd !== null ? (
          <form onSubmit={run} className="tui-cmd">
            <span>:</span>
            <input
              ref={cmdInput}
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setCmd(null); }}
              onBlur={() => setCmd(null)}
              aria-label="Command"
              spellCheck={false}
              autoComplete="off"
            />
          </form>
        ) : (
          <>
            <span className="tui-mode">NORMAL</span>
            <span>{file.name}</span>
            <span className="tui-dim tui-hints">j/k move · enter open · : command</span>
            <button type="button" className="tui-cmd-btn" onClick={() => setCmd("")}>:</button>
            <span className="tui-dim">{done ? `${body.split("\n").length}L` : "typing..."}</span>
          </>
        )}
      </footer>
    </div>
  );
}
