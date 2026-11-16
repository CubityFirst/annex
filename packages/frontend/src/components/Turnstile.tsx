import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
// How long to wait for the challenge script before telling the user it failed
// (it never arrives when a content blocker eats it).
const LOAD_TIMEOUT_MS = 8000;

declare global {
  interface Window {
    turnstile: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
          theme?: "light" | "dark" | "auto";
          size?: "normal" | "flexible" | "compact";
        },
      ) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

interface TurnstileProps {
  onVerify: (token: string) => void;
  onExpire?: () => void;
}

export interface TurnstileHandle {
  reset: () => void;
}

export const Turnstile = forwardRef<TurnstileHandle, TurnstileProps>(function Turnstile(
  { onVerify, onExpire },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onVerifyRef = useRef(onVerify);
  const onExpireRef = useRef(onExpire);
  onVerifyRef.current = onVerify;
  onExpireRef.current = onExpire;
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Turnstile tokens are single-use at siteverify, so a failed submit must
  // re-run the challenge. reset() replays it and fires the callback with a
  // fresh token.
  useImperativeHandle(ref, () => ({
    reset() {
      if (widgetIdRef.current) {
        window.turnstile.reset(widgetIdRef.current);
      }
    },
  }), []);

  useEffect(() => {
    const sitekey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const startedAt = Date.now();

    // render() throws on a bad/missing sitekey; never let that blank the page.
    function render() {
      if (!containerRef.current) return;
      try {
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey,
          callback: (token) => onVerifyRef.current(token),
          "expired-callback": () => onExpireRef.current?.(),
          "error-callback": () => onExpireRef.current?.(),
          theme: "dark",
          size: "flexible",
        });
      } catch (err) {
        console.error("Turnstile failed to render", err);
        setFailed(true);
      }
    }

    // A retry after the script was blocked asks for it again.
    if (attempt > 0 && !window.turnstile) {
      const script = document.createElement("script");
      script.src = TURNSTILE_SRC;
      script.async = true;
      document.head.appendChild(script);
    }

    if (window.turnstile) {
      render();
    } else {
      intervalId = setInterval(() => {
        if (window.turnstile) {
          clearInterval(intervalId!);
          intervalId = null;
          render();
        } else if (Date.now() - startedAt > LOAD_TIMEOUT_MS) {
          clearInterval(intervalId!);
          intervalId = null;
          setFailed(true);
        }
      }, 100);
    }

    return () => {
      if (intervalId !== null) clearInterval(intervalId);
      if (widgetIdRef.current) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [attempt]);

  if (failed) {
    return (
      <div role="alert" className="flex w-full items-center gap-3 rounded-md border bg-muted/40 px-3 py-2.5 text-sm">
        <AlertTriangle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-muted-foreground">
          <span className="font-medium text-foreground">Verification couldn't load.</span>{" "}
          If a content blocker is on, allow challenges.cloudflare.com, then retry.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => { setFailed(false); setAttempt(a => a + 1); }}
        >
          Retry
        </Button>
      </div>
    );
  }

  return <div className="flex justify-center"><div ref={containerRef} /></div>;
});
