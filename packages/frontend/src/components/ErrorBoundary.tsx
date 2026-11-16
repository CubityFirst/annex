import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: ReactNode;
  // Clears a caught error when it changes (pass the pathname so navigating
  // away from a broken page recovers without a reload).
  resetKey?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// Catches render/effect errors below it so one broken page shows a calm
// recovery panel instead of unmounting the whole app to a blank screen.
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled UI error", error, info.componentStack);
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <ErrorFallback error={this.state.error} />;
  }
}

function ErrorFallback({ error }: { error: Error }) {
  return (
    <div role="alert" className="flex w-full justify-center bg-background px-4 py-[16vh] text-foreground">
      <div className="w-full max-w-md">
        <AlertTriangle className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <h1 className="mt-4 text-lg font-semibold">Something went wrong on this page</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Annex hit an unexpected error while showing it. Reloading usually fixes this; your saved
          documents are safe.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button onClick={() => window.location.reload()} className="gap-1.5">
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
            Reload
          </Button>
          <Button variant="outline" asChild>
            <a href="/dashboard">Go to dashboard</a>
          </Button>
        </div>
        {error.message && (
          <details className="mt-6 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none hover:text-foreground">Error details</summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono">
              {error.message}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
