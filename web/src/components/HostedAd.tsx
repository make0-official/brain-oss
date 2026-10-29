import { useState } from "react";
import { ArrowUpRightIcon } from "./icons";

const AD_KEY = "make0-brain-hide-hosted-ad";
const HOSTED_URL = "https://make0.ai";
const TITLE = "Use hosted Brain on Make0";
const PITCH = "Connect ChatGPT and Claude on the web. Synced across every device.";

/** Floating pill on the memory board. Dismissing it is remembered. */
export function HostedAdPill() {
  const [hidden, setHidden] = useState(() => localStorage.getItem(AD_KEY) === "1");
  if (hidden) return null;
  return (
    <div className="absolute bottom-3 left-3 z-[4] flex max-w-[min(28rem,calc(100vw-28rem))] min-w-0 items-center gap-0.5 rounded-full border border-slate-300/80 bg-[#fbfaf8]/90 py-1.5 pr-1 pl-1.5 shadow-[0_12px_32px_rgba(15,23,42,0.08)] backdrop-blur-md max-md:max-w-44 dark:border-white/10 dark:bg-[#0d1117]/90">
      <a href={HOSTED_URL} target="_blank" rel="noopener noreferrer" className="group flex min-w-0 flex-1 items-center gap-2">
        <img src="/logo.png" alt="" width={22} height={22} className="shrink-0 rounded-md" />
        <span className="min-w-0">
          <strong className="block truncate text-xs text-slate-950 group-hover:underline dark:text-white">{TITLE}</strong>
          <em className="block truncate text-[11px] font-medium text-slate-500 not-italic dark:text-slate-400">{PITCH}</em>
        </span>
      </a>
      <button
        type="button"
        aria-label="Dismiss hosted Brain ad"
        onClick={() => {
          localStorage.setItem(AD_KEY, "1");
          setHidden(true);
        }}
        className="grid size-[22px] shrink-0 cursor-pointer place-items-center rounded-full text-sm text-slate-500 hover:bg-black/[0.05] hover:text-slate-950 dark:hover:bg-white/[0.08] dark:hover:text-white"
      >
        ×
      </button>
    </div>
  );
}

/** Full-width banner for page footers. */
export function HostedAdBanner() {
  return (
    <a
      href={HOSTED_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex flex-wrap items-center gap-4 rounded-2xl border border-black/[0.08] bg-white p-4 transition-colors hover:border-black/[0.16] sm:flex-nowrap dark:border-white/10 dark:bg-panel-dark dark:hover:border-white/20"
    >
      <img src="/logo.png" alt="" width={40} height={40} className="shrink-0 rounded-xl" />
      <span className="min-w-0 flex-1">
        <strong className="block text-sm font-semibold tracking-tight text-slate-950 dark:text-white">{TITLE}</strong>
        <span className="mt-0.5 block text-[13px] text-slate-500 dark:text-slate-400">{PITCH}</span>
      </span>
      <span className="inline-flex h-9 shrink-0 items-center gap-1 rounded-full bg-slate-950 px-4 text-xs font-semibold text-white group-hover:bg-slate-800 dark:bg-white dark:text-slate-950 dark:group-hover:bg-slate-200">
        Open make0.ai
        <ArrowUpRightIcon size={13} />
      </span>
    </a>
  );
}
