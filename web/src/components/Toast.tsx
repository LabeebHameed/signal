import { ReactNode } from "react";
import { Toaster, toast as toastManager } from "@/components/ui/toast";

type Tone = "success" | "error";

interface ToastContextValue {
  show: (text: string, tone?: Tone) => void;
}

/**
 * The app's single notification surface, backed by the Base UI toast
 * primitive. `useToast().show(text, tone)` is kept as the call signature the
 * rest of the app already speaks — only the rendering moved.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  return <Toaster>{children}</Toaster>;
}

export function useToast(): ToastContextValue {
  return {
    show: (text: string, tone: Tone = "success") => {
      toastManager.add({
        title: tone === "error" ? "Something went wrong" : "Done",
        description: text,
        type: tone,
      });
    },
  };
}
