import { useEffect, useRef, useState } from "react";
import type { Mermaid } from "mermaid";

// Mermaid is ~heavy (Cytoskeleton/d3/dagre). Load it once, lazily, on the
// first diagram the user actually views so it stays out of the main bundle.
let _mermaid: Mermaid | null = null;
let _loading: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  if (_mermaid) return Promise.resolve(_mermaid);
  if (_loading) return _loading;
  _loading = import("mermaid").then(({ default: m }) => {
    m.initialize({
      startOnLoad: false,
      // App is dark-only (matches the Shiki code-block surface).
      theme: "dark",
      // User-authored diagram source - keep mermaid's DOMPurify sanitization
      // and block inline event handlers / foreignObject script vectors.
      securityLevel: "strict",
      fontFamily: "inherit",
    });
    _mermaid = m;
    return m;
  });
  return _loading;
}

// mermaid.render() needs a DOM-id-safe, document-unique handle for the
// temporary node it mounts while measuring. useId() is unique per React tree
// but separate CodeMirror widget roots can repeat ids, so add a global counter.
let _seq = 0;

interface MermaidDiagramProps {
  code: string;
}

/** Renders a ```mermaid fenced block as an SVG diagram. */
export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef<string>(`mermaid-${++_seq}`);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    loadMermaid()
      .then((m) => m.render(idRef.current, code))
      .then(({ svg }) => {
        if (!cancelled) setSvg(svg);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSvg(null);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error !== null) {
    return (
      <div className="not-prose relative my-4">
        <div className="rounded-t-md border border-b-0 border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">
          Mermaid diagram error: {error}
        </div>
        <pre className="overflow-x-auto rounded-b-md border border-border bg-card p-4 text-sm text-foreground/85">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  if (svg === null) {
    // First-paint placeholder while the mermaid chunk loads / renders.
    return (
      <div className="not-prose my-4 rounded-md border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      className="cm-mermaid not-prose my-4 flex justify-center overflow-x-auto rounded-md border border-border bg-card p-4"
      // mermaid sanitizes its own output via DOMPurify (securityLevel: strict).
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
