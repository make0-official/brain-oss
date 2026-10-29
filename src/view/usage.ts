import type { BrainStore, UsageRow } from "../store/store";
import { agentName } from "./brains";

export type UsagePoint = { day: string; reads: number; writes: number; tokensIn: number; tokensOut: number };
export type UsageTotals = Omit<UsagePoint, "day">;

export type ViewUsage = {
  days: string[];
  total: UsagePoint[];
  month: UsageTotals;
  clients: Array<{ id: string; name: string; points: UsagePoint[]; month: UsageTotals }>;
  brains: Record<string, { points: UsagePoint[]; month: UsageTotals }>;
  /** One series per app and brain pair, so the activity view can filter by both. */
  series: Array<{ clientId: string; brainId: string; points: UsagePoint[] }>;
};

function emptyTotals(): UsageTotals {
  return { reads: 0, writes: 0, tokensIn: 0, tokensOut: 0 };
}

function add(target: UsageTotals, row: UsageTotals): void {
  target.reads += row.reads;
  target.writes += row.writes;
  target.tokensIn += row.tokensIn;
  target.tokensOut += row.tokensOut;
}

function utcDaysBack(now: Date, count: number): string[] {
  const days: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset));
    days.push(date.toISOString().slice(0, 10));
  }
  return days;
}

function series(days: string[], rows: UsageRow[]): UsagePoint[] {
  const byDay = new Map(days.map((day) => [day, { day, ...emptyTotals() }]));
  for (const row of rows) {
    const point = byDay.get(row.day);
    if (point) add(point, row);
  }
  return days.map((day) => byDay.get(day)!);
}

function monthTotals(rows: UsageRow[], monthStart: string): UsageTotals {
  const totals = emptyTotals();
  for (const row of rows) if (row.day >= monthStart) add(totals, row);
  return totals;
}

function groupBy(rows: UsageRow[], key: (row: UsageRow) => string): Map<string, UsageRow[]> {
  const groups = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const list = groups.get(key(row)) ?? [];
    list.push(row);
    groups.set(key(row), list);
  }
  return groups;
}

/** Daily reads and writes for the last `dayCount` UTC days, plus this month's totals. */
export function buildViewUsage(store: BrainStore, dayCount = 31, now = new Date()): ViewUsage {
  const days = utcDaysBack(now, Math.min(366, Math.max(7, Math.floor(dayCount))));
  const monthStart = `${now.toISOString().slice(0, 7)}-01`;
  const rows = store.listUsage(days[0] < monthStart ? days[0] : monthStart);
  const seen = new Map(store.listSeenClients().map((client) => [client.id, client.name]));
  return {
    days,
    total: series(days, rows),
    month: monthTotals(rows, monthStart),
    clients: [...groupBy(rows, (row) => row.clientId)].map(([id, list]) => ({
      id,
      name: agentName(id, seen.get(id)),
      points: series(days, list),
      month: monthTotals(list, monthStart),
    })),
    brains: Object.fromEntries(
      [...groupBy(rows, (row) => row.brainId)].map(([id, list]) => [
        id,
        { points: series(days, list), month: monthTotals(list, monthStart) },
      ]),
    ),
    series: [...groupBy(rows, (row) => `${row.clientId}\u0000${row.brainId}`)].map(([, list]) => ({
      clientId: list[0].clientId,
      brainId: list[0].brainId,
      points: series(days, list),
    })),
  };
}
