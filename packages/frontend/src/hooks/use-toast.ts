import type * as React from "react";
import { toast as sonnerToast } from "sonner";

type Variant = "default" | "destructive";

interface ToastInput {
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: Variant;
  // Inline button on the toast, e.g. "Undo" after moving an item to the bin.
  action?: { label: string; onClick: () => void };
}

function toast({ title, description, variant, action }: ToastInput) {
  const fn = variant === "destructive" ? sonnerToast.error : sonnerToast.success;
  const id = fn(title ?? "", { description, action });
  return { id, dismiss: () => sonnerToast.dismiss(id) };
}

function useToast() {
  return {
    toast,
    dismiss: (id?: string | number) => sonnerToast.dismiss(id),
  };
}

export { useToast, toast };
