import { cn } from "./ui";

const LOGOS: Record<string, string> = {
  "claude-code": "claude",
  "claude-desktop": "claude",
  cursor: "cursor",
  codex: "openai",
  windsurf: "windsurf",
  gemini: "googlegemini",
  vscode: "visualstudiocode",
  hermes: "hermes",
  openclaw: "openclaw",
  claude: "claude",
  chatgpt: "openai",
};

const NAME_LOGOS: Array<[RegExp, string]> = [
  [/claude/i, "claude"],
  [/cursor/i, "cursor"],
  [/codex|chatgpt|openai/i, "openai"],
  [/windsurf/i, "windsurf"],
  [/gemini/i, "googlegemini"],
  [/vs ?code|copilot|visual studio/i, "visualstudiocode"],
  [/hermes/i, "hermes"],
  [/openclaw/i, "openclaw"],
];

/** Logo file for an app id or memory provider, falling back to the app's name for generic MCP writes. */
export function logoFor(id: string, name?: string | null): string | null {
  if (LOGOS[id]) return `/logos/${LOGOS[id]}.svg`;
  const match = name ? NAME_LOGOS.find(([pattern]) => pattern.test(name)) : undefined;
  return match ? `/logos/${match[1]}.svg` : null;
}

export function AppMark({ id, name, className }: { id: string; name: string; className?: string }) {
  const logo = logoFor(id, name);
  if (id === "user") {
    return (
      <span title={name} className={cn("grid size-8 shrink-0 place-items-center rounded-lg bg-slate-900 text-[11px] font-bold text-white dark:bg-white dark:text-slate-900", className)}>
        You
      </span>
    );
  }
  return (
    <span
      title={name}
      className={cn(
        "grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg",
        logo ? "bg-white ring-1 ring-black/[0.08]" : "bg-slate-500 text-xs font-bold text-white",
        className,
      )}
    >
      {logo ? (
        <img src={logo} alt="" draggable={false} className="size-[58%] object-contain" />
      ) : (
        (name || id).charAt(0).toUpperCase()
      )}
    </span>
  );
}
