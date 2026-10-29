import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ChevronLeftIcon,
  CloseIcon,
  RefreshIcon,
  SearchIcon,
  SlidersIcon,
  TrashIcon,
} from "../components/icons";
import { logoFor } from "../components/AppMark";
import { HostedAdPill } from "../components/HostedAd";
import { Button, ChromeButton, CopyField, ErrorText, Modal, ThemeButton, Toaster, cn, toast } from "../components/ui";
import {
  ago,
  api,
  enc,
  plural,
  writerLabel,
  type Brain,
  type Embedding,
  type Memory,
  type MemoryList,
  type MemorySearchHit,
  type MemorySearchResult,
  type MemoryVersion,
  type ViewConfig,
} from "../lib/api";

const brainId = new URLSearchParams(location.search).get("brain") || "personal";
const listUrl = `/api/memories?brain=${enc(brainId)}`;
const VIEW_KEY = "make0-brain-board-view";
const SEARCH_DEBOUNCE_MS = 300;
const EMPTY_HITS: MemorySearchHit[] = [];
const GraphView = lazy(() => import("../components/GraphView"));

type ViewMode = "board" | "3d";

type Draft = { mode: "new" | "edit"; id: string | null; category: string; content: string };

type Overlay =
  | { kind: "writer" }
  | { kind: "version"; version: MemoryVersion }
  | { kind: "bin" }
  | { kind: "sync" }
  | { kind: "settings" }
  | { kind: "embedding" }
  | null;

export function BoardPage() {
  const [brain, setBrain] = useState<Brain | null>(null);
  const [list, setList] = useState<MemoryList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<MemorySearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const latestQuery = useRef(query);
  const searchedList = useRef<MemoryList | null>(null);
  latestQuery.current = query;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [versions, setVersions] = useState<MemoryVersion[]>([]);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [view, setViewState] = useState<ViewMode>(() =>
    (new URLSearchParams(location.search).get("view") ?? localStorage.getItem(VIEW_KEY)) === "3d" ? "3d" : "board",
  );
  const setView = (next: ViewMode) => {
    localStorage.setItem(VIEW_KEY, next);
    setViewState(next);
  };

  const loadVersions = useCallback(async (id: string) => {
    const payload = await api<{ versions: MemoryVersion[] }>("GET", `/api/memories/${enc(id)}/versions`);
    setVersions(payload.versions);
  }, []);

  const openMemory = useCallback(
    (memory: Memory) => {
      setDraft({ mode: "edit", id: memory.id, category: memory.category, content: memory.content });
      setFormError(null);
      setVersions([]);
      void loadVersions(memory.id);
    },
    [loadVersions],
  );

  const reload = useCallback(
    async (focusId: string | null) => {
      try {
        const [brains, memories] = await Promise.all([
          api<{ brains: Brain[] }>("GET", "/api/brains"),
          api<MemoryList>("GET", listUrl),
        ]);
        const current = brains.brains.find((item) => item.id === brainId);
        if (!current) {
          location.replace("/");
          return;
        }
        setBrain(current);
        setList(memories);
        setLoadError(null);
        document.title = current.name;
        const focus = focusId ? memories.memories.find((item) => item.id === focusId) : undefined;
        if (focus) openMemory(focus);
      } catch (caught) {
        setLoadError(caught instanceof Error ? caught.message : "Couldn’t load Brain");
      }
    },
    [openMemory],
  );

  useEffect(() => {
    void reload(null);
  }, [reload]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !overlay) setDraft(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlay]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResult(null);
      setSearching(false);
      setSearchFailed(false);
      searchedList.current = null;
      return;
    }
    if (searchResult?.query === trimmed && searchedList.current === list) {
      setSearching(false);
      return;
    }
    setSearching(true);
    setSearchFailed(false);
    const controller = new AbortController();
    const requestedList = list;
    const timer = window.setTimeout(() => {
      void api<MemorySearchResult>("GET", `/api/search?brain=${enc(brainId)}&q=${enc(trimmed)}`, undefined, controller.signal)
        .then((result) => {
          if (controller.signal.aborted || latestQuery.current.trim() !== result.query) return;
          searchedList.current = requestedList;
          setSearchResult(result);
          setSearching(false);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
          if (latestQuery.current.trim() !== trimmed) return;
          setSearching(false);
          setSearchFailed(true);
          toast(error instanceof Error ? error.message : "Search failed");
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, searchResult, list]);

  const memories = list?.memories ?? [];
  const archived = list?.archived ?? [];
  const selected = draft?.mode === "edit" ? memories.find((memory) => memory.id === draft.id) ?? null : null;
  const trimmedQuery = query.trim();
  const searchExact = searchResult?.query === trimmedQuery ? searchResult : null;
  const visibleHits = !trimmedQuery ? null : (searchResult?.hits ?? EMPTY_HITS);
  const searchPending = trimmedQuery.length > 0 && !searchExact;

  const columns = useMemo(() => groupColumns(memories, visibleHits), [memories, visibleHits]);
  const categoryCount = new Set(memories.map((memory) => memory.category)).size;
  const matchingIds = useMemo(
    () => (visibleHits ? new Set(visibleHits.map((hit) => hit.id)) : undefined),
    [visibleHits],
  );

  const compose = (category: string) => {
    setDraft({ mode: "new", id: null, category: category.trim(), content: "" });
    setFormError(null);
    setVersions([]);
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!draft) return;
    setSaving(true);
    setFormError(null);
    try {
      const body = { category: draft.category, content: draft.content };
      const saved =
        draft.mode === "new"
          ? await api<Memory>("POST", listUrl, body)
          : await api<Memory>("PATCH", `/api/memories/${enc(draft.id!)}`, body);
      await reload(saved.id);
      toast(draft.mode === "new" ? "Memory added" : "Memory saved");
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Couldn’t save that memory.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft?.id) return;
    if (!confirm("Delete this memory? It moves to the recycle bin, where you can recover it or delete it permanently.")) return;
    try {
      await api("DELETE", `/api/memories/${enc(draft.id)}`);
      setDraft(null);
      await reload(null);
      toast("Moved to the recycle bin");
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Couldn’t delete that memory.");
    }
  };

  const restoreVersion = async (versionNumber: number) => {
    if (!draft?.id) return;
    if (!confirm(`Make version ${versionNumber} the current text? Later versions stay in the history.`)) return;
    try {
      await api("POST", `/api/memories/${enc(draft.id)}/versions/${versionNumber}/restore`);
      setOverlay(null);
      await reload(draft.id);
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Couldn’t restore that version.");
    }
  };

  return (
    <div className="relative h-full overflow-hidden">
      <div className="board-grid pointer-events-none absolute inset-0" aria-hidden />

      <header className="absolute inset-x-3 top-3 z-10 flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="flex h-9 min-w-0 items-center gap-1.5 rounded-full border border-slate-300/80 bg-[#fbfaf8]/90 pr-3 pl-1.5 shadow-[0_12px_32px_rgba(15,23,42,0.08)] backdrop-blur-md dark:border-white/10 dark:bg-[#0d1117]/90">
            <a
              href="/"
              aria-label="All brains"
              className="grid size-6 place-items-center rounded-full text-slate-500 hover:bg-black/[0.05] hover:text-slate-950 dark:text-slate-400 dark:hover:bg-white/[0.08] dark:hover:text-white"
            >
              <ChevronLeftIcon size={14} />
            </a>
            {brain?.emoji ? <span className="text-base leading-none">{brain.emoji}</span> : <img src="/logo.png" alt="" width={18} height={18} className="rounded" />}
            <strong className="truncate text-sm tracking-tight text-slate-950 dark:text-white">{brain?.name ?? "Brain"}</strong>
            {brain?.kind === "personal" ? (
              <span className="shrink-0 rounded-full border border-black/[0.08] px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-slate-500 uppercase dark:border-white/10 dark:text-slate-400">
                System
              </span>
            ) : null}
          </div>
          {memories.length > 0 ? (
            <div className="hidden h-9 shrink-0 items-center rounded-full border border-slate-300/80 bg-[#fbfaf8]/90 px-3 text-[11px] font-medium whitespace-nowrap shadow-[0_12px_32px_rgba(15,23,42,0.08)] backdrop-blur-md lg:flex dark:border-white/10 dark:bg-[#0d1117]/90">
              {plural(categoryCount, "category", "categories")}
              <span className="mx-1.5 text-slate-400">·</span>
              {plural(memories.length, "memory", "memories")}
            </div>
          ) : null}
          <div
            role="group"
            aria-label="Memory view"
            className="flex h-9 shrink-0 items-center rounded-full border border-slate-300/80 bg-[#fbfaf8]/90 p-1 shadow-[0_12px_32px_rgba(15,23,42,0.08)] backdrop-blur-md dark:border-white/10 dark:bg-[#0d1117]/90"
          >
            {(["board", "3d"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={view === mode}
                onClick={() => setView(mode)}
                className={cn(
                  "h-7 cursor-pointer rounded-full px-3 text-xs font-semibold",
                  view === mode
                    ? "bg-slate-950 text-white dark:bg-white dark:text-slate-950"
                    : "text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white",
                )}
              >
                {mode === "board" ? "Board" : "3D"}
              </button>
            ))}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <MemorySearch
            query={query}
            searching={searching && !searchExact}
            searchMs={searchExact ? searchExact.searchMs : null}
            onChange={setQuery}
          />
          <ChromeButton aria-label={archived.length ? `Recycle bin, ${archived.length} archived` : "Recycle bin"} onClick={() => setOverlay({ kind: "bin" })}>
            <TrashIcon />
            {archived.length ? (
              <span className="absolute -top-1.5 -right-1.5 min-w-4 rounded-full bg-red-700 px-1 text-[10px] leading-4 font-bold text-white">
                {archived.length}
              </span>
            ) : null}
          </ChromeButton>
          <ChromeButton aria-label="Brain configuration" onClick={() => setOverlay({ kind: "settings" })}>
            <SlidersIcon />
          </ChromeButton>
          <ThemeButton chrome />
          <button
            type="button"
            onClick={() => setOverlay({ kind: "sync" })}
            className="h-9 cursor-pointer rounded-full border border-slate-300/80 bg-[#fbfaf8]/90 px-3 text-xs font-semibold text-slate-950 shadow-[0_12px_32px_rgba(15,23,42,0.08)] backdrop-blur-md hover:bg-white dark:border-white/10 dark:bg-[#0d1117]/90 dark:text-white dark:hover:bg-[#161b22]"
          >
            Connect / import / export
          </button>
          <ChromeButton aria-label="Refresh memories" onClick={() => void reload(draft?.id ?? null)}>
            <RefreshIcon />
          </ChromeButton>
        </div>
      </header>

      <HostedAdPill />

      {view === "3d" && list && !loadError ? (
        <main className="absolute inset-0">
          {memories.length === 0 ? (
            <StatusPill>No memories yet. Switch to Board to add one.</StatusPill>
          ) : searchPending && columns.length === 0 ? (
            <StatusPill>{searchFailed ? "Search failed" : "Searching…"}</StatusPill>
          ) : trimmedQuery && columns.length === 0 ? (
            <StatusPill>No matches for “{trimmedQuery}”</StatusPill>
          ) : (
            <Suspense fallback={<StatusPill>Loading 3D view…</StatusPill>}>
              <GraphView
                memories={memories}
                edges={list.edges ?? []}
                visibleIds={matchingIds}
                selectedId={selected?.id ?? null}
                onSelect={(memory) => (memory ? openMemory(memory) : setDraft(null))}
              />
            </Suspense>
          )}
        </main>
      ) : (
        <main className="absolute inset-0 flex items-center gap-3 overflow-x-auto overflow-y-hidden px-4 pt-14 pb-20">
          {loadError ? (
            <StatusPill>Couldn’t load Brain</StatusPill>
          ) : !list ? (
            <StatusPill>Loading Brain…</StatusPill>
          ) : memories.length === 0 && !trimmedQuery ? (
            <NewCategoryColumn onCompose={compose} />
          ) : searchPending && columns.length === 0 ? (
            <StatusPill>{searchFailed ? "Search failed" : "Searching…"}</StatusPill>
          ) : columns.length === 0 ? (
            <StatusPill>No matches for “{trimmedQuery}”</StatusPill>
          ) : (
            <>
              {!trimmedQuery ? <NewCategoryColumn onCompose={compose} /> : null}
              {columns.map((column) => (
                <section
                  key={column.label}
                  className="flex max-h-[calc(100%-4rem)] w-[min(18.5rem,calc(100vw-2.5rem))] shrink-0 flex-col overflow-hidden rounded-2xl border border-slate-300/80 bg-[#fbfaf8] shadow-[0_12px_32px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-[#06080c]"
                >
                  <header className="shrink-0 border-b border-black/[0.08] px-3 pt-3 pb-2.5 dark:border-white/10">
                    <h2 className="truncate text-sm font-semibold text-slate-950 dark:text-white">{column.label}</h2>
                    <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{plural(column.items.length, "memory", "memories")}</p>
                    <Button variant="ghost" size="sm" className="mt-2.5 w-full" onClick={() => compose(column.label)}>
                      Add memory
                    </Button>
                  </header>
                  <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                    {column.items.map((memory) => (
                      <li key={memory.id}>
                        <MemoryCard memory={memory} selected={memory.id === selected?.id} onOpen={() => openMemory(memory)} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}
        </main>
      )}

      {draft ? (
        <aside className="absolute top-[60px] right-3 bottom-3 z-[6] flex w-[min(24rem,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl border border-slate-300/80 bg-[#fbfaf8] shadow-[0_12px_32px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-[#0d1117]">
          <header className="flex items-start gap-2 border-b border-black/[0.08] px-4 pt-3.5 pb-3 dark:border-white/10">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold text-slate-950 dark:text-white">{draft.mode === "new" ? "New memory" : selected?.category ?? "Memory"}</h2>
              {draft.mode === "new" ? (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Saving writes version 1.</p>
              ) : (
                <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <OriginMark
                    addedBy={selected?.addedBy ?? "make0"}
                    className=""
                    writerName={selected && selected.addedBy === selected.updatedBy ? selected.writerName : null}
                  />
                  Added by {writerLabel(selected?.addedBy ?? "make0", selected && selected.addedBy === selected.updatedBy ? selected.writerName : null)}
                </p>
              )}
              {draft.mode === "edit" ? (
                <button type="button" className="mt-1.5 cursor-pointer text-xs font-semibold text-slate-500 underline hover:text-slate-900 dark:text-slate-400 dark:hover:text-white" onClick={() => setOverlay({ kind: "embedding" })}>
                  View embedding
                </button>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Close memory"
              onClick={() => setDraft(null)}
              className="grid size-8 cursor-pointer place-items-center rounded-full text-slate-500 hover:bg-black/[0.05] hover:text-slate-950 dark:hover:bg-white/[0.08] dark:hover:text-white"
            >
              <CloseIcon size={14} />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <form onSubmit={(event) => void save(event)} className="grid gap-1 p-4">
              <label htmlFor="edit-category" className="text-[11px] text-slate-500 dark:text-slate-400">
                Category
              </label>
              <input
                id="edit-category"
                required
                maxLength={80}
                value={draft.category}
                onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                className="mb-3 h-9 rounded-xl border border-slate-300/80 bg-white px-2.5 text-sm text-slate-950 outline-none focus:border-slate-950 dark:border-white/10 dark:bg-white/[0.04] dark:text-white dark:focus:border-white"
              />
              <div className="flex items-center justify-between">
                <label htmlFor="edit-content" className="text-[11px] text-slate-500 dark:text-slate-400">
                  Memory
                </label>
                <button type="button" className="cursor-pointer text-xs font-semibold text-slate-500 underline hover:text-slate-900 dark:text-slate-400 dark:hover:text-white" onClick={() => setOverlay({ kind: "writer" })}>
                  Larger writer
                </button>
              </div>
              <textarea
                id="edit-content"
                required
                autoFocus={draft.mode === "new"}
                maxLength={4000}
                value={draft.content}
                onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                className="mb-3 min-h-[140px] resize-y rounded-xl border border-slate-300/80 bg-white p-2.5 text-sm leading-relaxed text-slate-950 outline-none focus:border-slate-950 dark:border-white/10 dark:bg-white/[0.04] dark:text-white dark:focus:border-white"
              />
              <div className="flex gap-2">
                <Button type="submit" className="flex-1" disabled={saving}>
                  {saving ? "Saving…" : draft.mode === "new" ? "Add memory" : "Save"}
                </Button>
                {draft.mode === "edit" ? (
                  <Button variant="ghost" className="text-red-700 dark:text-red-400" onClick={() => void remove()}>
                    Delete
                  </Button>
                ) : null}
              </div>
              <div className="mt-2">
                <ErrorText>{formError}</ErrorText>
              </div>
            </form>
            {draft.mode === "edit" && versions.length > 0 ? (
              <section className="border-t border-black/[0.08] p-4 dark:border-white/10">
                <h3 className="mb-1 text-xs font-semibold text-slate-950 dark:text-white">Versions</h3>
                {versions.map((version) => (
                  <article key={version.versionNumber} className="flex items-start justify-between gap-3 border-t border-black/[0.06] py-3 first-of-type:border-t-0 dark:border-white/[0.08]">
                    <div className="min-w-0">
                      <p className={cn("mb-1 flex flex-wrap items-center gap-x-1 text-[11px]", version.isCurrent ? "font-semibold text-slate-950 dark:text-white" : "text-slate-500 dark:text-slate-400")}>
                        v{version.versionNumber} ·
                        <OriginMark addedBy={version.writtenBy} writerName={version.writerName} className="" />
                        {writerLabel(version.writtenBy, version.writerName)} · {ago(version.createdAt)}
                        {version.isCurrent ? (
                          <span className="ml-1.5 rounded-full bg-slate-950 px-1.5 py-px text-[10px] font-bold text-white dark:bg-white dark:text-slate-950">Current</span>
                        ) : null}
                      </p>
                      <p className="line-clamp-3 text-xs leading-snug text-slate-700 dark:text-slate-300">{version.content}</p>
                      <button type="button" className="mt-1.5 cursor-pointer text-xs font-semibold text-slate-500 underline hover:text-slate-900 dark:text-slate-400 dark:hover:text-white" onClick={() => setOverlay({ kind: "version", version })}>
                        View
                      </button>
                    </div>
                    {versions.length > 1 && !version.isCurrent ? (
                      <Button size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => void restoreVersion(version.versionNumber)}>
                        Make current
                      </Button>
                    ) : null}
                  </article>
                ))}
              </section>
            ) : null}
          </div>
        </aside>
      ) : null}

      {overlay?.kind === "writer" && draft ? (
        <WriterModal
          draft={draft}
          onChange={setDraft}
          onClose={() => setOverlay(null)}
          onSave={() => {
            setOverlay(null);
            void save();
          }}
        />
      ) : null}
      {overlay?.kind === "version" && draft?.id ? (
        <VersionModal memoryId={draft.id} version={overlay.version} onClose={() => setOverlay(null)} onRestore={(n) => void restoreVersion(n)} />
      ) : null}
      {overlay?.kind === "bin" ? (
        <BinModal
          archived={archived}
          onClose={() => setOverlay(null)}
          onChanged={async (recoveredId) => {
            await reload(recoveredId);
            if (recoveredId) setOverlay(null);
          }}
        />
      ) : null}
      {overlay?.kind === "sync" ? <SyncModal onClose={() => setOverlay(null)} /> : null}
      {overlay?.kind === "settings" ? <SettingsModal onClose={() => setOverlay(null)} /> : null}
      {overlay?.kind === "embedding" && draft?.id ? <EmbeddingModal memoryId={draft.id} onClose={() => setOverlay(null)} /> : null}
      <Toaster />
    </div>
  );
}

function groupColumns(memories: Memory[], hits: MemorySearchHit[] | null) {
  const rank = hits ? new Map(hits.map((hit, index) => [hit.id, index])) : null;
  const groups = new Map<string, Memory[]>();
  for (const memory of memories) {
    if (rank && !rank.has(memory.id)) continue;
    groups.set(memory.category, [...(groups.get(memory.category) ?? []), memory]);
  }
  return [...groups.entries()]
    .map(([label, items]) => ({
      label,
      items: rank ? [...items].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)) : items,
    }))
    .sort((a, b) => {
      if (!rank) return b.items.length - a.items.length || a.label.localeCompare(b.label);
      const best = (items: Memory[]) => Math.min(...items.map((item) => rank.get(item.id) ?? Number.POSITIVE_INFINITY));
      return best(a.items) - best(b.items) || a.label.localeCompare(b.label);
    });
}

function formatSearchMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  return `${seconds >= 10 ? Math.round(seconds).toString() : seconds.toFixed(1)} s`;
}

function MemorySearch({
  query,
  onChange,
  searching,
  searchMs,
}: {
  query: string;
  onChange: (value: string) => void;
  searching: boolean;
  searchMs: number | null;
}) {
  const active = query.trim().length > 0;
  return (
    <label
      className={cn(
        "flex h-11 w-[min(18rem,calc(100vw-8rem))] min-w-0 items-center gap-2 rounded-full border bg-white pr-3 pl-3.5 shadow-[0_16px_40px_rgba(15,23,42,0.14)] focus-within:ring-2 dark:bg-[#0d1117]",
        active
          ? "border-sky-500 focus-within:ring-sky-500/20 dark:border-cyan-300 dark:focus-within:ring-cyan-300/20"
          : "border-slate-400/90 focus-within:border-slate-950 focus-within:ring-slate-950/10 dark:border-white/25 dark:focus-within:border-white dark:focus-within:ring-white/15",
      )}
    >
      <SearchIcon size={16} className={active ? "shrink-0 text-sky-600 dark:text-cyan-300" : "shrink-0 text-slate-500 dark:text-slate-400"} />
      <input
        type="search"
        value={query}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search..."
        aria-label="Search memories"
        aria-busy={searching}
        autoComplete="off"
        spellCheck={false}
        className="h-full min-w-0 flex-1 bg-transparent text-sm text-slate-950 outline-none placeholder:text-slate-500 dark:text-white dark:placeholder:text-slate-400 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
      />
      {searchMs != null ? (
        <span
          title="Search time"
          aria-live="polite"
          className="shrink-0 text-[11px] font-medium tabular-nums whitespace-nowrap text-slate-500 dark:text-slate-400"
        >
          {formatSearchMs(searchMs)}
        </span>
      ) : searching ? (
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-sky-500 dark:bg-cyan-300" aria-hidden />
      ) : null}
    </label>
  );
}

function StatusPill({ children }: { children: ReactNode }) {
  return (
    <div className="flex size-full items-center justify-center p-8 text-center">
      <p className="rounded-full border border-slate-300/80 bg-[#fbfaf8] px-4 py-2 text-sm shadow-[0_12px_32px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-[#0d1117]">{children}</p>
    </div>
  );
}

function NewCategoryColumn({ onCompose }: { onCompose: (category: string) => void }) {
  const [name, setName] = useState("");
  return (
    <section className="w-[min(18.5rem,calc(100vw-2.5rem))] shrink-0 rounded-2xl border border-dashed border-slate-300 bg-[#fbfaf8]/70 dark:border-white/15 dark:bg-[#06080c]/70">
      <form
        className="px-3 pt-3 pb-3"
        onSubmit={(event) => {
          event.preventDefault();
          onCompose(name);
        }}
      >
        <h2 className="text-sm font-semibold text-slate-950 dark:text-white">New category</h2>
        <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">Name a list, then add a memory to it.</p>
        <input
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Health"
          aria-label="New category name"
          className="mt-2.5 h-8 w-full rounded-lg border border-slate-300/80 bg-white px-2 text-xs text-slate-950 outline-none focus:border-slate-950 dark:border-white/10 dark:bg-white/[0.04] dark:text-white"
        />
        <Button type="submit" variant="ghost" size="sm" className="mt-2.5 w-full">
          Add memory
        </Button>
      </form>
    </section>
  );
}

const ORIGIN_MARKS: Record<string, { text: string; className: string }> = {
  user: { text: "Y", className: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200" },
  claude: { text: "C", className: "bg-[#d97757] text-white" },
  chatgpt: { text: "G", className: "bg-[#10a37f] text-white" },
  cursor: { text: "Cu", className: "bg-[#111] text-white dark:bg-slate-50 dark:text-[#111]" },
  mcp: { text: "M", className: "bg-indigo-500 text-white" },
};

function OriginMark({ addedBy, writerName, className = "mt-0.5" }: { addedBy: string; writerName?: string | null; className?: string }) {
  if (addedBy === "make0") return <img src="/logo.png" alt="" title="Make0" className={cn("size-5 shrink-0 rounded-[5px] bg-black object-cover", className)} />;
  const logo = logoFor(addedBy, writerName);
  if (logo) {
    return (
      <span title={writerLabel(addedBy, writerName)} className={cn("grid size-5 shrink-0 place-items-center rounded-[5px] bg-white ring-1 ring-black/[0.08]", className)}>
        <img src={logo} alt="" draggable={false} className="size-3.5 object-contain" />
      </span>
    );
  }
  const mark = ORIGIN_MARKS[addedBy] ?? { text: "•", className: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200" };
  return (
    <span title={writerLabel(addedBy)} className={cn(className, "grid size-5 shrink-0 place-items-center rounded-full text-[9px] font-bold", mark.className)}>
      {mark.text}
    </span>
  );
}

function MemoryCard({ memory, selected, onOpen }: { memory: Memory; selected: boolean; onOpen: () => void }) {
  const preview = memory.content.length <= 100 ? memory.content : `${memory.content.slice(0, 100).trimEnd()}…`;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "w-full cursor-pointer rounded-xl border bg-white text-left shadow-[0_1px_2px_rgba(15,23,42,0.05)] dark:bg-white/[0.04]",
        selected ? "border-slate-900/55 ring-1 ring-slate-900/55 dark:border-white/55 dark:ring-white/55" : "border-black/[0.06] dark:border-white/10",
      )}
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        <OriginMark addedBy={memory.addedBy} writerName={memory.addedBy === memory.updatedBy ? memory.writerName : null} />
        <p className="min-w-0 flex-1 text-[13px] leading-snug text-slate-900 dark:text-slate-100">{preview}</p>
      </div>
      {memory.edited ? (
        <p className="pr-3 pb-2 pl-10 text-[10px] text-slate-500 dark:text-slate-400">
          Updated by {writerLabel(memory.updatedBy, memory.writerName)} {ago(memory.updatedAt)}
        </p>
      ) : null}
    </button>
  );
}

function WriterModal({
  draft,
  onChange,
  onClose,
  onSave,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <Modal open onClose={onClose} size="xl" title={draft.mode === "new" ? "New memory" : draft.category || "Memory"}>
      <form
        className="flex min-h-0 flex-1 flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <label htmlFor="writer-category" className="text-[11px] text-slate-500 dark:text-slate-400">
          Category
        </label>
        <input
          id="writer-category"
          required
          maxLength={80}
          value={draft.category}
          onChange={(event) => onChange({ ...draft, category: event.target.value })}
          className="h-9 rounded-xl border border-slate-300/80 bg-white px-2.5 text-sm text-slate-950 outline-none focus:border-slate-950 dark:border-white/10 dark:bg-white/[0.04] dark:text-white"
        />
        <label htmlFor="writer-content" className="text-[11px] text-slate-500 dark:text-slate-400">
          Memory
        </label>
        <textarea
          id="writer-content"
          required
          autoFocus
          maxLength={4000}
          value={draft.content}
          onChange={(event) => onChange({ ...draft, content: event.target.value })}
          className="min-h-64 flex-1 resize-none rounded-xl border border-slate-300/80 bg-white p-3.5 text-[15px] leading-relaxed text-slate-950 outline-none focus:border-slate-950 dark:border-white/10 dark:bg-white/[0.04] dark:text-white"
        />
        <div className="mt-1 flex items-center justify-end gap-3">
          <button type="button" onClick={onClose} className="cursor-pointer text-xs font-semibold text-slate-500 underline hover:text-slate-900 dark:text-slate-400 dark:hover:text-white">
            Done
          </button>
          <Button type="submit" className="min-w-28">
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function VersionModal({
  memoryId,
  version,
  onClose,
  onRestore,
}: {
  memoryId: string;
  version: MemoryVersion;
  onClose: () => void;
  onRestore: (versionNumber: number) => void;
}) {
  const [embedding, setEmbedding] = useState<Embedding | null>(null);
  const [vectorError, setVectorError] = useState<string | null>(null);
  useEffect(() => {
    if (!version.isCurrent) return;
    api<Embedding>("GET", `/api/memories/${enc(memoryId)}/embedding`)
      .then(setEmbedding)
      .catch(() => setVectorError("Couldn’t load the embedding."));
  }, [memoryId, version.isCurrent]);
  const model = version.embeddingModel || embedding?.storedModel;
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Version ${version.versionNumber}`}
      description={`v${version.versionNumber} · ${writerLabel(version.writtenBy, version.writerName)} · ${ago(version.createdAt)}`}
      footer={
        !version.isCurrent ? (
          <Button onClick={() => onRestore(version.versionNumber)}>Make current</Button>
        ) : undefined
      }
    >
      <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">{model ? `Embedder · ${model}` : "Embedder · not recorded for this version"}</p>
      <pre className="rounded-xl bg-[#faf9f7] p-3 text-sm leading-relaxed whitespace-pre-wrap text-slate-900 dark:bg-white/[0.04] dark:text-slate-100">{version.content}</pre>
      {version.isCurrent ? <VectorBlock embedding={embedding} error={vectorError} /> : null}
    </Modal>
  );
}

function VectorBlock({ embedding, error }: { embedding: Embedding | null; error: string | null }) {
  const text = error
    ? error
    : !embedding
      ? "Loading embedding…"
      : embedding.values
        ? embedding.values.join(", ")
        : "No vector is stored for the current text.";
  return (
    <pre className="mt-2 max-h-56 overflow-auto rounded-xl bg-[#faf9f7] p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-slate-600 dark:bg-white/[0.04] dark:text-slate-400">
      {text}
    </pre>
  );
}

function BinModal({
  archived,
  onClose,
  onChanged,
}: {
  archived: Memory[];
  onClose: () => void;
  onChanged: (recoveredId: string | null) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const recover = async (memory: Memory) => {
    setBusy(memory.id);
    try {
      const restored = await api<Memory>("POST", `/api/memories/${enc(memory.id)}/restore`);
      await onChanged(restored.id);
      toast("Memory recovered");
    } catch (caught) {
      alert(caught instanceof Error ? caught.message : "Couldn’t recover that memory.");
    } finally {
      setBusy(null);
    }
  };
  const purge = async (memory: Memory) => {
    if (!confirm("Delete this memory permanently? Its versions are removed and cannot be recovered.")) return;
    setBusy(memory.id);
    try {
      await api("POST", `/api/memories/${enc(memory.id)}/purge`);
      await onChanged(null);
    } catch (caught) {
      alert(caught instanceof Error ? caught.message : "Couldn’t delete that memory.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal open onClose={onClose} size="lg" title="Recycle bin" description={archived.length ? plural(archived.length, "archived memory", "archived memories") : undefined}>
      {archived.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">The recycle bin is empty.</p>
      ) : (
        archived.map((memory) => (
          <article key={memory.id} className="border-t border-black/[0.06] py-3 first:border-t-0 first:pt-0 dark:border-white/[0.08]">
            <h3 className="mb-1 text-xs font-semibold text-slate-950 dark:text-white">{memory.category}</h3>
            <p className="text-[13px] leading-snug text-slate-700 dark:text-slate-300">{memory.content}</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="ghost" disabled={busy === memory.id} onClick={() => void recover(memory)}>
                Recover
              </Button>
              <Button size="sm" variant="ghost" className="text-red-700 dark:text-red-400" disabled={busy === memory.id} onClick={() => void purge(memory)}>
                Delete permanently
              </Button>
            </div>
          </article>
        ))
      )}
    </Modal>
  );
}

const SYNC_GUIDE = [
  {
    title: "Connect your AI apps",
    detail: "Run init once, then choose each app’s brains on the Your brains page. Quit the app fully and reopen it after init.",
    commands: ["npx @make0-ai/brain init"],
  },
  {
    title: "Import",
    detail:
      "A folder, an Obsidian vault, agent rule files, or text you paste. --extract turns notes into short facts and needs an API key. --dry-run shows the plan first. Refresh this page when the command finishes.",
    commands: [
      "npx @make0-ai/brain import ~/Documents/MyVault",
      "npx @make0-ai/brain import --detect",
      "npx @make0-ai/brain import ~/Notes --brain Work",
      "pbpaste | npx @make0-ai/brain import -",
    ],
  },
  {
    title: "Export",
    detail:
      "Markdown writes one file per memory. The JSON file keeps versions and links. Cloud port (make0-brain login, then make0-brain port) comes later; keep the JSON bundle for that upload.",
    commands: ["npx @make0-ai/brain export ./my-brain", "npx @make0-ai/brain export --json brain.json"],
  },
];

function SyncModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal open onClose={onClose} size="lg" title="Connect / import / export">
      <div className="grid gap-5">
        {SYNC_GUIDE.map((section) => (
          <section key={section.title} className="min-w-0">
            <h3 className="text-[13px] font-semibold text-slate-950 dark:text-white">{section.title}</h3>
            <p className="mt-1 mb-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{section.detail}</p>
            <div className="grid gap-1.5">
              {section.commands.map((command) => (
                <CopyField key={command} value={command} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  );
}

function ConfigRow({ label, title, detail }: { label: string; title: string; detail?: string }) {
  return (
    <div className="mb-3.5">
      <dt className="text-[11px] font-bold tracking-wider text-slate-500 uppercase dark:text-slate-400">{label}</dt>
      <dd className="mt-1 text-sm leading-relaxed text-slate-950 dark:text-white">
        <strong>{title}</strong>
        {detail ? <div className="text-xs text-slate-500 dark:text-slate-400">{detail}</div> : null}
      </dd>
    </div>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<ViewConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<ViewConfig>("GET", "/api/config")
      .then(setConfig)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Couldn’t load configuration."));
  }, []);
  return (
    <Modal open onClose={onClose} size="lg" title="Brain configuration">
      {error ? (
        <ErrorText>{error}</ErrorText>
      ) : !config ? (
        <p className="text-sm text-slate-500">Loading configuration…</p>
      ) : (
        <dl>
          <ConfigRow label="Embedder" title={config.embedder.name} detail={`${config.embedder.model} · ${config.embedder.dimensions} dimensions. ${config.embedder.detail}`} />
          <ConfigRow label="Reranker" title={config.reranker.name} detail={`${config.reranker.model}. ${config.reranker.detail}`} />
          <ConfigRow label="Search" title="Hybrid retrieval" detail={config.retrieval} />
          <ConfigRow label="Language model" title={config.llm.enabled ? config.llm.model : "Off"} detail={config.llm.detail} />
          <ConfigRow label="Database" title="SQLite" detail={config.database} />
          <pre className="rounded-xl bg-[#faf9f7] p-3 text-xs leading-relaxed whitespace-pre-wrap text-slate-500 dark:bg-white/[0.04] dark:text-slate-400">{config.howToChange}</pre>
        </dl>
      )}
    </Modal>
  );
}

function EmbeddingModal({ memoryId, onClose }: { memoryId: string; onClose: () => void }) {
  const [embedding, setEmbedding] = useState<Embedding | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Embedding>("GET", `/api/memories/${enc(memoryId)}/embedding`)
      .then(setEmbedding)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Couldn’t load the embedding."));
  }, [memoryId]);
  const status = !embedding
    ? ""
    : embedding.missing
      ? "The embedder did not return a vector. Open this again to retry."
      : embedding.stale
        ? `Stored with ${embedding.storedModel}. The current embedder is ${embedding.embedder.model}.`
        : `Stored with ${embedding.storedModel || embedding.embedder.model}.`;
  return (
    <Modal open onClose={onClose} size="lg" title="Embedding">
      {error ? (
        <ErrorText>{error}</ErrorText>
      ) : !embedding ? (
        <p className="text-sm text-slate-500">Embedding this memory…</p>
      ) : (
        <dl>
          <ConfigRow label="Embedder" title={embedding.embedder.name} detail={`${embedding.embedder.model} · ${embedding.embedder.dimensions} dimensions`} />
          <ConfigRow label="This memory" title={embedding.missing ? "Not embedded yet" : `${embedding.dimensions} numbers`} detail={status} />
          {embedding.values ? <VectorBlock embedding={embedding} error={null} /> : null}
        </dl>
      )}
    </Modal>
  );
}
