import { useMemo, useState, type ReactNode } from "react";
import type { UsagePoint, UsageTotals } from "../lib/api";
import { ArrowUpRightIcon } from "./icons";
import { cn } from "./ui";

export type Measure = "memories" | "tokens";

export function totalsOf(points: UsagePoint[]): UsageTotals {
  return points.reduce(
    (sum, point) => ({
      reads: sum.reads + point.reads,
      writes: sum.writes + point.writes,
      tokensIn: sum.tokensIn + point.tokensIn,
      tokensOut: sum.tokensOut + point.tokensOut,
    }),
    { reads: 0, writes: 0, tokensIn: 0, tokensOut: 0 },
  );
}

export function measureValues(value: UsageTotals, measure: Measure): { out: number; in: number } {
  return measure === "tokens" ? { out: value.tokensOut, in: value.tokensIn } : { out: value.reads, in: value.writes };
}

export function measureLabels(measure: Measure): { out: string; in: string } {
  return measure === "tokens" ? { out: "tokens out", in: "tokens in" } : { out: "retrieved", in: "added" };
}

export function MiniTabs<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex shrink-0 rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.07]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "cursor-pointer rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
            value === option.value
              ? "bg-white text-slate-950 shadow-sm dark:bg-white/[0.12] dark:text-white"
              : "text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function LegendDot({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      <span className="truncate">{children}</span>
    </span>
  );
}

const READS = "var(--color-reads)";
const WRITES = "var(--color-writes)";

function shortDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Paired daily bars: retrieved (orange) and added (grey). */
export function UsageChart({ points, measure, height = 112 }: { points: UsagePoint[]; measure: Measure; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = points.map((point) => measureValues(point, measure));
  const peak = Math.max(4, ...values.map((value) => Math.max(value.out, value.in)));
  const slot = 100 / Math.max(points.length, 1);
  const bar = Math.max(slot * 0.32, 0.6);
  const labels = measureLabels(measure);
  const active = hover == null ? null : points[hover];
  const activeValues = hover == null ? null : values[hover];
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="block w-full"
        style={{ height }}
        onMouseLeave={() => setHover(null)}
      >
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line
            key={ratio}
            x1="0"
            x2="100"
            y1={height * ratio}
            y2={height * ratio}
            className="stroke-black/[0.06] dark:stroke-white/[0.08]"
            strokeWidth="0.5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {values.map((value, index) => {
          const x = index * slot + (slot - bar * 2) / 2;
          const outHeight = (value.out / peak) * (height - 4);
          const inHeight = (value.in / peak) * (height - 4);
          return (
            <g key={points[index].day} onMouseEnter={() => setHover(index)}>
              <rect x={index * slot} y="0" width={slot} height={height} fill="transparent" />
              {hover === index ? (
                <rect x={index * slot} y="0" width={slot} height={height} className="fill-black/[0.04] dark:fill-white/[0.06]" />
              ) : null}
              <rect x={x} y={height - outHeight} width={bar} height={outHeight} fill={READS} rx="0.4" />
              <rect x={x + bar} y={height - inHeight} width={bar} height={inHeight} fill={WRITES} rx="0.4" />
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400 tabular-nums">
        <span>{points[0] ? shortDay(points[0].day) : ""}</span>
        <span>{points.length ? shortDay(points[points.length - 1].day) : ""}</span>
      </div>
      {active && activeValues ? (
        <div className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 rounded-lg border border-black/[0.08] bg-white px-2.5 py-1.5 text-[11px] whitespace-nowrap shadow-lg tabular-nums dark:border-white/10 dark:bg-[#1c2128]">
          <div className="font-semibold text-slate-950 dark:text-white">{shortDay(active.day)}</div>
          <div className="mt-0.5 flex gap-3 text-slate-500 dark:text-slate-400">
            <LegendDot color={READS}>
              {activeValues.out.toLocaleString()} {labels.out}
            </LegendDot>
            <LegendDot color={WRITES}>
              {activeValues.in.toLocaleString()} {labels.in}
            </LegendDot>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Memories / This month / Activity, like the Make0 cloud brain hub. */
export function UsageStats({
  memoryCount,
  points,
  month,
  onExpand,
}: {
  memoryCount: number;
  points: UsagePoint[];
  month: UsageTotals;
  /** Opens the full activity view with the current range and measure. */
  onExpand?: (range: "7d" | "30d", measure: Measure) => void;
}) {
  const [range, setRange] = useState<"7d" | "30d">("7d");
  const [measure, setMeasure] = useState<Measure>("memories");
  const recent = useMemo(() => points.slice(range === "7d" ? -7 : -30), [points, range]);
  const recentTotals = useMemo(() => totalsOf(recent), [recent]);
  const labels = measureLabels(measure);
  const monthValues = measureValues(month, measure);
  const recentValues = measureValues(recentTotals, measure);
  return (
    <>
      <div className="grid grid-cols-2 gap-4 px-5 pt-4 pb-5">
        <div className="min-w-0">
          <p className="text-xs text-slate-500 dark:text-slate-400">Memories</p>
          <p className="mt-1 truncate text-2xl font-semibold tracking-tight text-slate-950 tabular-nums dark:text-white">
            {memoryCount.toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Across all brains</p>
        </div>
        <div className="min-w-0">
          <p className="text-xs text-slate-500 dark:text-slate-400">This month</p>
          <p className="mt-1 truncate text-2xl font-semibold tracking-tight text-slate-950 tabular-nums dark:text-white">
            {monthValues.out.toLocaleString()}
          </p>
          <p className="mt-1 truncate text-[11px] text-slate-500 tabular-nums dark:text-slate-400">
            {labels.out} · {monthValues.in.toLocaleString()} {labels.in}
          </p>
        </div>
      </div>
      <section className="border-t border-black/[0.06] px-5 pt-4 pb-4 dark:border-white/[0.08]">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[13px] font-medium text-slate-950 dark:text-white">Activity</h2>
          {onExpand ? (
            <button
              type="button"
              onClick={() => onExpand(range, measure)}
              className="inline-flex cursor-pointer items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-slate-500 hover:bg-black/[0.04] hover:text-slate-950 dark:text-slate-400 dark:hover:bg-white/[0.08] dark:hover:text-white"
            >
              Details
              <ArrowUpRightIcon size={14} />
            </button>
          ) : null}
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <MiniTabs
            label="Date range"
            value={range}
            onChange={setRange}
            options={[
              { value: "7d", label: "7d" },
              { value: "30d", label: "30d" },
            ]}
          />
          <MiniTabs
            label="What to count"
            value={measure}
            onChange={setMeasure}
            options={[
              { value: "memories", label: "Memories" },
              { value: "tokens", label: "Tokens" },
            ]}
          />
        </div>
        <p className="mt-3 mb-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500 tabular-nums dark:text-slate-400">
          <LegendDot color={READS}>
            {recentValues.out.toLocaleString()} {labels.out}
          </LegendDot>
          <LegendDot color={WRITES}>
            {recentValues.in.toLocaleString()} {labels.in}
          </LegendDot>
        </p>
        {onExpand ? (
          <button type="button" aria-label="Open activity details" onClick={() => onExpand(range, measure)} className="block w-full cursor-pointer text-left">
            <UsageChart points={recent} measure={measure} />
          </button>
        ) : (
          <UsageChart points={recent} measure={measure} />
        )}
      </section>
    </>
  );
}
