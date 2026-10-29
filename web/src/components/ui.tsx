import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CloseIcon, MoonIcon, SunIcon } from "./icons";
import { useTheme } from "../lib/theme";

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "ghost" | "danger" | "soft";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-slate-950 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200",
  ghost:
    "border border-black/10 bg-transparent text-slate-700 hover:bg-black/[0.04] dark:border-white/15 dark:text-slate-200 dark:hover:bg-white/[0.06]",
  danger: "bg-red-600 text-white hover:bg-red-700",
  soft: "bg-black/[0.04] text-slate-700 hover:bg-black/[0.07] dark:bg-white/[0.07] dark:text-slate-200 dark:hover:bg-white/[0.1]",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full font-semibold whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-3 text-xs" : "h-9 px-4 text-[13px]",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}

/** Round floating control used in page chrome. */
export function ChromeButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "relative grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border border-slate-300/80 bg-[#fbfaf8]/90 text-slate-900 shadow-[0_12px_32px_rgba(15,23,42,0.08)] backdrop-blur-md transition-colors hover:bg-white dark:border-white/10 dark:bg-[#0d1117]/90 dark:text-white dark:hover:bg-[#161b22]",
        className,
      )}
      {...props}
    />
  );
}

export function ThemeButton({ chrome = false }: { chrome?: boolean }) {
  const [dark, toggle] = useTheme();
  const label = dark ? "Switch to light mode" : "Switch to dark mode";
  const icon = dark ? <SunIcon /> : <MoonIcon />;
  if (chrome) {
    return (
      <ChromeButton aria-label={label} onClick={toggle}>
        {icon}
      </ChromeButton>
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      onClick={toggle}
      className="grid size-9 cursor-pointer place-items-center rounded-full border border-black/10 bg-white text-slate-500 hover:text-slate-900 dark:border-white/10 dark:bg-panel-dark dark:text-slate-400 dark:hover:text-white"
    >
      {icon}
    </button>
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  actions,
  children,
  size = "md",
  flush = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  /** Controls shown in the header, left of the close button. */
  actions?: ReactNode;
  children?: ReactNode;
  size?: "md" | "lg" | "xl" | "2xl";
  /** Body without padding, for layouts that draw their own dividers. */
  flush?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  const width = size === "2xl" ? "max-w-6xl" : size === "xl" ? "max-w-4xl h-[min(88vh,52rem)]" : size === "lg" ? "max-w-xl" : "max-w-md";
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-slate-950/45 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative flex max-h-[88vh] w-full flex-col overflow-hidden rounded-2xl border border-black/[0.08] bg-white shadow-2xl dark:border-white/10 dark:bg-panel-dark",
          width,
        )}
      >
        <header className="flex flex-wrap items-start gap-3 border-b border-black/[0.06] px-6 pt-5 pb-4 dark:border-white/[0.08]">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold tracking-tight text-slate-950 dark:text-white">{title}</h2>
            {description ? <p className="mt-1 text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mr-2 grid size-8 cursor-pointer place-items-center rounded-full text-slate-500 hover:bg-black/[0.05] hover:text-slate-900 dark:hover:bg-white/[0.08] dark:hover:text-white"
          >
            <CloseIcon size={15} />
          </button>
        </header>
        {children ? <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", !flush && "px-6 py-5")}>{children}</div> : null}
        {footer ? (
          <footer className="flex justify-end gap-2 border-t border-black/[0.06] bg-[#faf9f7] px-6 py-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("grid min-w-0 gap-1.5", className)}>
      <span className="text-xs font-semibold text-slate-900 dark:text-white">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  "h-10 w-full min-w-0 rounded-xl border border-black/10 bg-white px-3 text-sm text-slate-950 outline-none placeholder:text-slate-400 focus:border-slate-950 focus:ring-2 focus:ring-slate-950/10 dark:border-white/10 dark:bg-white/[0.04] dark:text-white dark:focus:border-white dark:focus:ring-white/10";

export function CopyField({ value, multiline = false }: { value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(undefined);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-xl border border-black/[0.06] bg-white py-1.5 pr-1.5 pl-3 dark:border-white/[0.08] dark:bg-white/[0.04]">
      <code
        className={cn(
          "min-w-0 flex-1 py-1 font-mono text-xs leading-relaxed text-slate-800 dark:text-slate-200",
          multiline ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-nowrap",
        )}
      >
        {value}
      </code>
      <Button variant="ghost" size="sm" className="h-7" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

let pushToast: ((message: string) => void) | null = null;

export function toast(message: string): void {
  pushToast?.(message);
}

export function Toaster() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    pushToast = (next) => {
      setMessage(next);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setMessage(null), 2400);
    };
    return () => {
      pushToast = null;
      window.clearTimeout(timer);
    };
  }, []);
  if (!message) return null;
  return (
    <div className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-full bg-slate-950 px-4 py-2.5 text-[13px] font-semibold text-white shadow-xl dark:bg-white dark:text-slate-950">
      {message}
    </div>
  );
}

export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <p className="text-xs text-red-600 dark:text-red-400">{children}</p>;
}
