import { useEffect } from "react";
import { enterDemoMode } from "@/lib/demo";
import { pushRecentItem, readRecentItems } from "@/lib/recentDocs";

// Entry point for the demo sandbox (linked from the landing page's "See a
// demo"). Sets the demo flag, then hard-navigates to the dashboard so
// main.tsx boots with the in-memory demo API installed before anything
// fetches - a client-side navigate would race the already-finished boot.
export function DemoPage() {
  useEffect(() => {
    enterDemoMode();
    // Give the sandbox a lived-in feel: a couple of "recently opened" items so
    // the dashboard and sidebar show what they look like in real use.
    if (readRecentItems("demo-site").length === 0) {
      pushRecentItem("demo-site", { id: "demo-doc-coffee", title: "Coffee brewing guide", kind: "doc" });
      pushRecentItem("demo-site", { id: "demo-doc-tour", title: "Editor tour", kind: "doc" });
      pushRecentItem("demo-site", { id: "demo-doc-welcome", title: "Welcome to the Annex demo", kind: "doc" });
    }
    window.location.replace("/dashboard");
  }, []);
  return (
    <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
      Loading demo…
    </div>
  );
}
