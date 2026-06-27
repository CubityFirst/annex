import { useEffect } from "react";
import { enterDemoMode } from "@/lib/demo";

// Entry point for the demo sandbox (linked from the landing page's "See a
// demo"). Sets the demo flag, then hard-navigates to the dashboard so
// main.tsx boots with the in-memory demo API installed before anything
// fetches - a client-side navigate would race the already-finished boot.
export function DemoPage() {
  useEffect(() => {
    enterDemoMode();
    window.location.replace("/dashboard");
  }, []);
  return (
    <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
      Loading demo…
    </div>
  );
}
