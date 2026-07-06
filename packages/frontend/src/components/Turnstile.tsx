import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

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

    function render() {
      if (!containerRef.current) return;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey,
        callback: (token) => onVerifyRef.current(token),
        "expired-callback": () => onExpireRef.current?.(),
        "error-callback": () => onExpireRef.current?.(),
        theme: "dark",
        size: "flexible",
      });
    }

    if (window.turnstile) {
      render();
    } else {
      intervalId = setInterval(() => {
        if (window.turnstile) {
          clearInterval(intervalId!);
          intervalId = null;
          render();
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
  }, []);

  return <div className="flex justify-center"><div ref={containerRef} /></div>;
});
