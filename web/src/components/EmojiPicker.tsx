import { useState } from "react";
import { cn } from "./ui";

const EMOJIS = [
  "🧠", "💼", "🏠", "🚀", "💡", "📚", "🎯", "🛠️",
  "💻", "🧪", "🎨", "🎵", "✍️", "📈", "💰", "🧾",
  "🤝", "👥", "❤️", "🏃", "🍳", "✈️", "🌱", "🐾",
  "📁", "🗂️", "📝", "🔒", "⭐", "🔥", "⚡", "🌍",
  "🎓", "🏥", "⚖️", "🛒", "🎮", "📷", "🧘",
];

export function EmojiPicker({ value, onChange }: { value: string; onChange: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const pick = (emoji: string) => {
    onChange(emoji);
    setOpen(false);
  };
  return (
    <div className="relative grid gap-1.5">
      <span className="text-xs font-semibold text-slate-900 dark:text-white">Icon</span>
      <button
        type="button"
        aria-label="Choose an icon"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "grid h-10 w-16 cursor-pointer place-items-center rounded-xl border border-black/10 bg-white text-xl hover:bg-black/[0.03] dark:border-white/10 dark:bg-white/[0.04] dark:hover:bg-white/[0.08]",
          open && "ring-2 ring-slate-950/10 dark:ring-white/10",
        )}
      >
        <span className={value ? "" : "opacity-40"}>{value || "🙂"}</span>
      </button>
      {open ? (
        <div role="listbox" aria-label="Icons" className="absolute top-full left-0 z-10 mt-1.5 grid w-[19.5rem] grid-cols-8 gap-0.5 rounded-xl border border-black/10 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-[#1c2128]">
          <button
            type="button"
            aria-selected={!value}
            onClick={() => pick("")}
            className={cn(
              "h-9 cursor-pointer rounded-lg text-[11px] font-semibold text-slate-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]",
              !value && "bg-white ring-[1.5px] ring-slate-950 dark:bg-white/10 dark:ring-white",
            )}
          >
            None
          </button>
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="option"
              aria-selected={emoji === value}
              onClick={() => pick(emoji)}
              className={cn(
                "h-9 cursor-pointer rounded-lg text-[19px] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]",
                emoji === value && "bg-white ring-[1.5px] ring-slate-950 dark:bg-white/10 dark:ring-white",
              )}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
