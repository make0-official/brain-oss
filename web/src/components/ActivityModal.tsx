import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Agent, type Brain, type Usage, type UsagePoint, type UsageTotals } from "../lib/api";
import { AppMark } from "./AppMark";
import { ChevronRightIcon, RefreshIcon } from "./icons";
import { Modal, cn } from "./ui";
import { LegendDot, totalsOf } from "./UsagePanel";

const HISTORY_DAYS = 366;
const READS = "var(--color-reads)";
const WRITES = "var(--color-writes)";

export type ActivityRange = "1d" | "2d" | "7d" | "30d" | "last-month" | "6m" | "1y";
export type ActivityMeasure = "memories" | "tokens" | "average";
type Metric = "both" | "reads" | "writes";
type Bucket = "day" | "week" | "month";

function previousMonth(now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return {
    prefix: date.toISOString().slice(0, 8),
    name: date.toLocaleDateString(undefined, { month: "long", timeZone: "UTC" }),
  };
}

const RANGES: Array<{ id: ActivityRange; summary: () => string; bucket: Bucket; select: (points: UsagePoint[]) => UsagePoint[] }> = [
  { id: "1d", summary: () => "Today", bucket: "day", select: (p) => p.slice(-1) },
  { id: "2d", summary: () => "Last 2 days", bucket: "day", select: (p) => p.slice(-2) },
  { id: "7d", summary: () => "Last 7 days", bucket: "day", select: (p) => p.slice(-7) },
  { id: "30d", summary: () => "Last 30 days", bucket: "day", select: (p) => p.slice(-31) },
  {
    id: "last-month",
    summary: () => previousMonth().name,
    bucket: "day",
    select: (p) => p.filter((point) => point.day.startsWith(previousMonth().prefix)),
  },
  { id: "6m", summary: () => "Last 6 months", bucket: "week", select: (p) => p.slice(-183) },
  { id: "1y", summary: () => "Last 12 months", bucket: "month", select: (p) => p.slice(-365) },
];

function perEvent(tokens: number, count: number) {
  return count > 0 ? Math.round(tokens / count) : 0;
}

/** Retrieval-side and addition-side values for a measure. */
function values(value: UsageTotals, measure: ActivityMeasure): { reads: number; writes: number } {
  if (measure === "tokens") return { reads: value.tokensOut, writes: value.tokensIn };
  if (measure === "average") return { reads: perEvent(value.tokensOut, value.reads), writes: perEvent(value.tokensIn, value.writes) };
  return { reads: value.reads, writes: value.writes };
}

function labelsFor(measure: ActivityMeasure) {
  if (measure === "tokens") return { reads: "Tokens out", writes: "Tokens in", unit: "tokens" };
  if (measure === "average") return { reads: "Tokens per retrieval", writes: "Tokens per addition", unit: "tokens" };
  return { reads: "Retrieved", writes: "Added", unit: "events" };
}

function emptyPoint(day: string): UsagePoint {
  return { day, reads: 0, writes: 0, tokensIn: 0, tokensOut: 0 };
}

function combine(days: string[], series: UsagePoint[][]): UsagePoint[] {
  return days.map((day, index) => {
    const point = emptyPoint(day);
    for (const points of series) {
      const source = points[index];
      if (!source) continue;
      point.reads += source.reads;
      point.writes += source.writes;
      point.tokensIn += source.tokensIn;
      point.tokensOut += source.tokensOut;
    }
    return point;
  });
}

function utcDate(day: string) {
  return new Date(`${day}T00:00:00Z`);
}

/** Sums days into weeks (from Monday) or calendar months, keyed by each bucket's first day. */
function bucketPoints(points: UsagePoint[], bucket: Bucket): UsagePoint[] {
  if (bucket === "day") return points;
  const buckets = new Map<string, UsagePoint>();
  for (const point of points) {
    const date = utcDate(point.day);
    if (bucket === "week") date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    else date.setUTCDate(1);
    const key = date.toISOString().slice(0, 10);
    const current = buckets.get(key) ?? emptyPoint(key);
    current.reads += point.reads;
    current.writes += point.writes;
    current.tokensIn += point.tokensIn;
    current.tokensOut += point.tokensOut;
    buckets.set(key, current);
  }
  return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function formatDay(day: string) {
  return utcDate(day).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatBucket(day: string, bucket: Bucket) {
  if (bucket === "month") return utcDate(day).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
  if (bucket === "week") return `Week of ${formatDay(day)}`;
  return formatDay(day);
}

function formatTick(day: string, bucket: Bucket) {
  if (bucket === "month") return utcDate(day).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
  return formatDay(day);
}

function count(value: number) {
  return value.toLocaleString();
}

function niceCeiling(value: number) {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * magnitude >= value) return step * magnitude;
  return 10 * magnitude;
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; title?: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex w-max shrink-0 rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.07]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={cn(
            "cursor-pointer rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors",
            value === option.value
              ? "bg-white text-slate-950 shadow-sm dark:bg-white/[0.14] dark:text-white"
              : "text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SelectPill({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 max-w-[11rem] cursor-pointer truncate rounded-lg border-0 bg-black/[0.04] px-2.5 text-xs font-medium text-slate-900 outline-none dark:bg-white/[0.07] dark:text-white"
    >
      {children}
    </select>
  );
}

function StatTile({
  label,
  value,
  detail,
  color,
  active,
  onClick,
}: {
  label: string;
  value: string;
  detail?: string;
  color?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
        {color ? <span className="size-2 rounded-full" style={{ backgroundColor: color }} aria-hidden /> : null}
        {label}
      </span>
      <span className="mt-1 block truncate text-xl font-semibold tracking-tight text-slate-950 tabular-nums sm:text-2xl dark:text-white" title={value}>
        {value}
      </span>
      {detail ? <span className="mt-0.5 block truncate text-[11px] text-slate-500 dark:text-slate-400">{detail}</span> : null}
    </>
  );
  if (!onClick) return <div className="min-w-0 rounded-xl px-3 py-2.5">{body}</div>;
  return (
    <button
      type="button"
      aria-pressed={active}
      title={active ? `Show only ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
      onClick={onClick}
      className={cn(
        "min-w-0 cursor-pointer rounded-xl px-3 py-2.5 text-left transition-[opacity,background-color] hover:bg-black/[0.035] dark:hover:bg-white/[0.05]",
        !active && "opacity-40",
      )}
    >
      {body}
    </button>
  );
}

/** Area chart for daily ranges, bars for weeks and months, sized to its container. */
function ActivityChart({ points, measure, metric, bucket }: { points: UsagePoint[]; measure: ActivityMeasure; metric: Metric; bucket: Bucket }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const height = 320;
  const data = points.map((point) => values(point, measure));
  const showReads = metric !== "writes";
  const showWrites = metric !== "reads";
  const peak = niceCeiling(Math.max(0, ...data.map((value) => Math.max(showReads ? value.reads : 0, showWrites ? value.writes : 0))));
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(peak * ratio));
  const left = Math.max(28, count(peak).length * 7 + 12);
  const top = 8;
  const bottom = 26;
  const plotWidth = Math.max(1, width - left - 8);
  const plotHeight = height - top - bottom;
  const kind = bucket === "day" && points.length >= 3 ? "area" : "bar";
  const slot = plotWidth / Math.max(points.length, 1);
  const xAt = (index: number) => left + (kind === "area" ? (points.length > 1 ? (index / (points.length - 1)) * plotWidth : plotWidth / 2) : slot * index + slot / 2);
  const yAt = (value: number) => top + plotHeight - (value / peak) * plotHeight;
  const labels = labelsFor(measure);
  const tickEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotWidth / 72))));

  const areaPath = (key: "reads" | "writes") => {
    if (data.length === 0) return { line: "", fill: "" };
    const line = data.map((value, index) => `${index === 0 ? "M" : "L"}${xAt(index)},${yAt(value[key])}`).join(" ");
    const fill = `${line} L${xAt(data.length - 1)},${yAt(0)} L${xAt(0)},${yAt(0)} Z`;
    return { line, fill };
  };

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left - left;
    const index = kind === "area" ? Math.round((x / plotWidth) * (points.length - 1)) : Math.floor(x / slot);
    setHover(Math.min(points.length - 1, Math.max(0, index)));
  };

  const barWidth = Math.min(18, Math.max(2, (slot - 6) / (showReads && showWrites ? 2 : 1)));
  const active = hover == null ? null : points[hover];
  const activeValues = hover == null ? null : data[hover];

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 ? (
        <svg width={width} height={height} className="block" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={left}
                x2={left + plotWidth}
                y1={yAt(tick)}
                y2={yAt(tick)}
                strokeDasharray="4 6"
                className="stroke-black/[0.07] dark:stroke-white/[0.08]"
              />
              <text x={left - 8} y={yAt(tick)} dy="0.32em" textAnchor="end" className="fill-slate-400 text-[11px] tabular-nums">
                {count(tick)}
              </text>
            </g>
          ))}
          {points.map((point, index) =>
            index % tickEvery === 0 || index === points.length - 1 ? (
              <text
                key={point.day}
                x={xAt(index)}
                y={height - 6}
                textAnchor={kind === "area" && index === 0 ? "start" : kind === "area" && index === points.length - 1 ? "end" : "middle"}
                className="fill-slate-400 text-[11px]"
              >
                {formatTick(point.day, bucket)}
              </text>
            ) : null,
          )}
          {kind === "area" ? (
            <>
              {hover != null ? <line x1={xAt(hover)} x2={xAt(hover)} y1={top} y2={top + plotHeight} className="stroke-black/15 dark:stroke-white/20" /> : null}
              {showWrites ? (
                <>
                  <path d={areaPath("writes").fill} fill={WRITES} fillOpacity={0.22} />
                  <path d={areaPath("writes").line} fill="none" stroke={WRITES} strokeWidth={1.5} />
                </>
              ) : null}
              {showReads ? (
                <>
                  <path d={areaPath("reads").fill} fill={READS} fillOpacity={0.16} />
                  <path d={areaPath("reads").line} fill="none" stroke={READS} strokeWidth={1.5} />
                </>
              ) : null}
              {hover != null && activeValues ? (
                <>
                  {showReads ? <circle cx={xAt(hover)} cy={yAt(activeValues.reads)} r={3.5} fill={READS} /> : null}
                  {showWrites ? <circle cx={xAt(hover)} cy={yAt(activeValues.writes)} r={3.5} fill={WRITES} /> : null}
                </>
              ) : null}
            </>
          ) : (
            data.map((value, index) => {
              const center = xAt(index);
              const bars = [showReads ? { key: "reads", value: value.reads, fill: READS } : null, showWrites ? { key: "writes", value: value.writes, fill: WRITES } : null].filter(
                (bar): bar is { key: string; value: number; fill: string } => bar != null,
              );
              const start = center - (bars.length * barWidth + (bars.length - 1) * 2) / 2;
              return (
                <g key={points[index].day}>
                  {hover === index ? (
                    <rect x={center - slot / 2} y={top} width={slot} height={plotHeight} className="fill-black/[0.04] dark:fill-white/[0.06]" />
                  ) : null}
                  {bars.map((bar, barIndex) => {
                    const barHeight = Math.max(0, yAt(0) - yAt(bar.value));
                    return (
                      <rect key={bar.key} x={start + barIndex * (barWidth + 2)} y={yAt(bar.value)} width={barWidth} height={barHeight} rx={Math.min(3, barWidth / 2)} fill={bar.fill} />
                    );
                  })}
                </g>
              );
            })
          )}
        </svg>
      ) : null}
      {active && activeValues && hover != null ? (
        <div
          className="pointer-events-none absolute top-2 min-w-[12.5rem] rounded-lg border border-black/[0.08] bg-white px-3 py-2 text-xs shadow-lg tabular-nums dark:border-white/10 dark:bg-[#1c2128]"
          style={{
            left: Math.min(Math.max(xAt(hover) + 12, 0), Math.max(0, width - 220)),
          }}
        >
          <div className="mb-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">{formatBucket(active.day, bucket)}</div>
          {showReads ? (
            <div className="flex items-center justify-between gap-4">
              <LegendDot color={READS}>{labels.reads}</LegendDot>
              <span className="font-medium text-slate-950 dark:text-white">{count(activeValues.reads)}</span>
            </div>
          ) : null}
          {showWrites ? (
            <div className="flex items-center justify-between gap-4">
              <LegendDot color={WRITES}>{labels.writes}</LegendDot>
              <span className="font-medium text-slate-950 dark:text-white">{count(activeValues.writes)}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ActivityModal({
  brains,
  agents,
  initialRange,
  initialMeasure,
  onClose,
}: {
  brains: Brain[];
  agents: Agent[];
  initialRange: ActivityRange;
  initialMeasure: ActivityMeasure;
  onClose: () => void;
}) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rangeId, setRangeId] = useState<ActivityRange>(initialRange);
  const [brainId, setBrainId] = useState("all");
  const [measure, setMeasure] = useState<ActivityMeasure>(initialMeasure);
  const [metric, setMetric] = useState<Metric>("both");
  const [selected, setSelected] = useState<string[]>([]);
  const [showIdle, setShowIdle] = useState(false);
  const range = RANGES.find((option) => option.id === rangeId) ?? RANGES[2];

  const load = useCallback(async () => {
    setFetching(true);
    try {
      setUsage(await api<Usage>("GET", `/api/usage?days=${HISTORY_DAYS}`));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn’t load activity");
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const days = usage?.days ?? [];
  const sources = useMemo(() => {
    const names = new Map<string, string>();
    for (const agent of agents) names.set(agent.id, agent.name);
    for (const client of usage?.clients ?? []) names.set(client.id, client.name);
    const byClient = new Map<string, UsagePoint[][]>();
    for (const entry of usage?.series ?? []) {
      if (brainId !== "all" && entry.brainId !== brainId) continue;
      byClient.set(entry.clientId, [...(byClient.get(entry.clientId) ?? []), entry.points]);
    }
    const ids = new Set([...byClient.keys(), ...agents.filter((agent) => agent.connected).map((agent) => agent.id)]);
    return [...ids].map((id) => ({ id, name: names.get(id) ?? id, points: combine(days, byClient.get(id) ?? []) }));
  }, [agents, brainId, days, usage]);

  const isSelected = (id: string) => selected.length === 0 || selected.includes(id);
  const toggleSource = (id: string) =>
    setSelected((current) => {
      const base = current.length === 0 ? sources.map((source) => source.id) : current;
      const next = base.includes(id) ? base.filter((key) => key !== id) : [...base, id];
      return next.length === 0 || next.length === sources.length ? [] : next;
    });

  const rows = sources.map((source) => {
    const points = range.select(source.points);
    return { ...source, points, totals: totalsOf(points) };
  });
  const rangeDays = range.select(days.map(emptyPoint)).map((point) => point.day);
  const selectedRows = rows.filter((row) => isSelected(row.id));
  const points = rangeDays.map((day, index) => {
    const point = emptyPoint(day);
    for (const row of selectedRows) {
      const source = row.points[index];
      if (!source) continue;
      point.reads += source.reads;
      point.writes += source.writes;
      point.tokensIn += source.tokensIn;
      point.tokensOut += source.tokensOut;
    }
    return point;
  });
  const totals = totalsOf(points);
  const labels = labelsFor(measure);

  const metricTotal = (value: UsageTotals) => {
    const { reads, writes } = values(value, measure);
    if (metric === "reads") return reads;
    if (metric === "writes") return writes;
    if (measure === "average") {
      const events = value.reads + value.writes;
      return events > 0 ? Math.round((value.tokensIn + value.tokensOut) / events) : 0;
    }
    return reads + writes;
  };
  const shown = values(totals, measure);
  const busiest = points.reduce<UsagePoint | null>((best, point) => (!best || metricTotal(point) > metricTotal(best) ? point : best), null);
  const breakdownTotal = Math.max(
    1,
    measure === "average" ? Math.max(0, ...rows.map((row) => metricTotal(row.totals))) : rows.reduce((sum, row) => sum + metricTotal(row.totals), 0),
  );
  const sorted = [...rows].sort((a, b) => metricTotal(b.totals) - metricTotal(a.totals));
  const activeRows = sorted.filter((row) => metricTotal(row.totals) > 0);
  const idleRows = sorted.filter((row) => metricTotal(row.totals) === 0);
  const toggleSeries = (series: "reads" | "writes") => setMetric((current) => (current === series ? "both" : series));

  const renderRow = (row: (typeof rows)[number]) => {
    const on = isSelected(row.id);
    const value = metricTotal(row.totals);
    return (
      <button
        key={row.id}
        type="button"
        aria-pressed={on}
        onClick={() => toggleSource(row.id)}
        className={cn(
          "block w-full cursor-pointer rounded-lg px-2.5 py-2 text-left transition-[opacity,background-color] hover:bg-black/[0.035] dark:hover:bg-white/[0.05]",
          !on && "opacity-40",
        )}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            className={cn(
              "grid size-4 shrink-0 place-items-center rounded border text-[10px] leading-none font-bold",
              on ? "border-slate-950 bg-slate-950 text-white dark:border-white dark:bg-white dark:text-slate-950" : "border-black/20 dark:border-white/25",
            )}
            aria-hidden
          >
            {on ? "✓" : null}
          </span>
          <AppMark id={row.id} name={row.name} className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[13px] text-slate-900 dark:text-white">{row.name}</span>
          <span className="shrink-0 text-[13px] font-medium text-slate-700 tabular-nums dark:text-slate-300">{count(value)}</span>
        </span>
        {value > 0 ? (
          <span className="mt-1.5 ml-[3.25rem] block h-1 overflow-hidden rounded-full bg-black/[0.05] dark:bg-white/[0.08]">
            <span className="block h-full rounded-full bg-slate-300 dark:bg-slate-600" style={{ width: `${Math.max(2, (value / breakdownTotal) * 100)}%` }} />
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="2xl"
      flush
      title="Brain activity"
      description={`${range.summary()} · What your apps retrieved and added`}
      actions={
        <>
          <SelectPill label="Date range" value={rangeId} onChange={(value) => setRangeId(value as ActivityRange)}>
            {RANGES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.summary()}
              </option>
            ))}
          </SelectPill>
          {brains.length > 1 ? (
            <SelectPill
              label="Brain"
              value={brainId}
              onChange={(value) => {
                setBrainId(value);
                setSelected([]);
              }}
            >
              <option value="all">All brains</option>
              {brains.map((brain) => (
                <option key={brain.id} value={brain.id}>
                  {brain.name}
                </option>
              ))}
            </SelectPill>
          ) : null}
          <Segmented
            label="What to count"
            value={measure}
            onChange={(next) => {
              setMeasure(next);
              setMetric("both");
            }}
            options={[
              { value: "memories", label: "Memories" },
              { value: "tokens", label: "Tokens" },
              { value: "average", label: "Avg tokens", title: "Average tokens per retrieval and per addition" },
            ]}
          />
          <button
            type="button"
            aria-label="Refresh activity"
            title="Refresh"
            disabled={fetching}
            onClick={() => void load()}
            className="grid size-8 cursor-pointer place-items-center rounded-lg text-slate-500 hover:bg-black/[0.05] hover:text-slate-950 disabled:opacity-50 dark:hover:bg-white/[0.08] dark:hover:text-white"
          >
            <RefreshIcon size={14} className={fetching ? "animate-spin" : undefined} />
          </button>
        </>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0 px-3 pt-4 pb-5 sm:px-4">
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
            <StatTile label={labels.reads} value={count(shown.reads)} color={READS} active={metric !== "writes"} onClick={() => toggleSeries("reads")} />
            <StatTile label={labels.writes} value={count(shown.writes)} color={WRITES} active={metric !== "reads"} onClick={() => toggleSeries("writes")} />
            {measure === "average" ? (
              <>
                <StatTile label="Retrievals" value={count(totals.reads)} detail={`${count(totals.tokensOut)} tokens out`} />
                <StatTile label="Additions" value={count(totals.writes)} detail={`${count(totals.tokensIn)} tokens in`} />
              </>
            ) : (
              <>
                <StatTile label="Daily average" value={count(Math.round(metricTotal(totals) / Math.max(1, points.length)))} />
                <StatTile
                  label="Busiest day"
                  value={busiest && metricTotal(busiest) > 0 ? formatDay(busiest.day) : "—"}
                  detail={busiest && metricTotal(busiest) > 0 ? `${count(metricTotal(busiest))} ${labels.unit}` : undefined}
                />
              </>
            )}
          </div>
          <div className="px-1 pt-5 sm:px-2">
            {error ? (
              <p className="grid h-80 place-items-center text-sm text-red-700 dark:text-red-400">{error}</p>
            ) : !usage ? (
              <p className="grid h-80 place-items-center text-sm text-slate-500">Loading history…</p>
            ) : (
              <ActivityChart points={bucketPoints(points, range.bucket)} measure={measure} metric={metric} bucket={range.bucket} />
            )}
          </div>
        </div>

        <aside className="flex min-h-0 min-w-0 flex-col border-t border-black/[0.06] lg:border-t-0 lg:border-l dark:border-white/[0.08]">
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 lg:max-h-[32rem]">
            <div className="flex h-11 items-center justify-between px-2.5">
              <h3 className="text-xs font-medium text-slate-500 dark:text-slate-400">Sources</h3>
              {selected.length > 0 ? (
                <button
                  type="button"
                  className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white"
                  onClick={() => setSelected([])}
                >
                  Select all
                </button>
              ) : null}
            </div>
            {activeRows.length === 0 ? (
              <p className="px-2.5 py-2 text-xs text-slate-500 dark:text-slate-400">No activity in this range.</p>
            ) : (
              <div className="space-y-0.5">{activeRows.map(renderRow)}</div>
            )}
            {idleRows.length > 0 ? (
              <>
                <button
                  type="button"
                  aria-expanded={showIdle}
                  onClick={() => setShowIdle((value) => !value)}
                  className="mt-2 flex w-full cursor-pointer items-center gap-1 px-2.5 py-1.5 text-xs text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white"
                >
                  <ChevronRightIcon size={14} className={cn("transition-transform", showIdle && "rotate-90")} />
                  {idleRows.length} with no activity
                </button>
                {showIdle ? <div className="space-y-0.5">{idleRows.map(renderRow)}</div> : null}
              </>
            ) : null}
          </div>
        </aside>
      </div>
    </Modal>
  );
}
