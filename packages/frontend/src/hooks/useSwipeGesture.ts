import { useEffect, useRef } from "react";

interface SwipeOptions {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  threshold?: number;
}

export function useSwipeGesture({ onSwipeLeft, onSwipeRight, threshold = 50 }: SwipeOptions) {
  const startX = useRef(0);
  const startY = useRef(0);
  const lastX = useRef(0);
  const lastY = useRef(0);
  const leftRef = useRef(onSwipeLeft);
  const rightRef = useRef(onSwipeRight);

  leftRef.current = onSwipeLeft;
  rightRef.current = onSwipeRight;

  useEffect(() => {
    function onTouchStart(e: TouchEvent) {
      startX.current = e.touches[0].clientX;
      startY.current = e.touches[0].clientY;
      lastX.current = e.touches[0].clientX;
      lastY.current = e.touches[0].clientY;
    }

    function onTouchMove(e: TouchEvent) {
      lastX.current = e.touches[0].clientX;
      lastY.current = e.touches[0].clientY;
    }

    function evaluate(clientX: number, clientY: number) {
      const dx = clientX - startX.current;
      const dy = clientY - startY.current;
      if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy)) return;
      if (dx < 0) leftRef.current?.();
      else rightRef.current?.();
    }

    function onTouchEnd(e: TouchEvent) {
      evaluate(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    }

    // When the browser cancels a touch (e.g. it claimed the gesture for native
    // scrolling), changedTouches may be empty - fall back to the last tracked position.
    function onTouchCancel(e: TouchEvent) {
      const x = e.changedTouches[0]?.clientX ?? lastX.current;
      const y = e.changedTouches[0]?.clientY ?? lastY.current;
      evaluate(x, y);
    }

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [threshold]);
}
