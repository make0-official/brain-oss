import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ActivityModal, type ActivityMeasure, type ActivityRange } from "../components/ActivityModal";
import { AppMark } from "../components/AppMark";
import { EmojiPicker } from "../components/EmojiPicker";
import { BrainIcon, ChevronRightIcon, CopyIcon, LockIcon, MoreIcon, PlusIcon } from "../components/icons";
import { UsageStats } from "../components/UsagePanel";
import { Button, CopyField, ErrorText, Field, inputClass, Modal, ThemeButton, Toaster, cn, toast } from "../components/ui";
import { HostedAdBanner } from "../components/HostedAd";
import { api, enc, plural, type Agent, type Brain, type Usage, type ViewConfig } from "../lib/api";

const INIT_COMMAND = "npx @make0-ai/brain init";
const MCP_CONFIG = `{
  "mcpServers": {
    "make0-brain": {
      "command": "npx",
      "args": ["-y", "@make0-ai/brain"]
    }
  }
}`;

function brainEmoji(brain: Brain): string {
  return brain.emoji || (brain.kind === "personal" ? "🧠" : "📁");
}

function brainHref(brain: Brain): string {
  return `/brain?brain=${enc(brain.id)}`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export function BrainsPage() {
  const [brains, setBrains] = useState<Brain[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Brain | "new" | null>(null);
  const [managing, setManaging] = useState<Agent | null>(null);
  const [deleting, setDeleting] = useState<Brain | null>(null);
  const [activity, setActivity] = useState<{ range: ActivityRange; measure: ActivityMeasure } | null>(null);
  const [config, setConfig] = useState<ViewConfig | null>(null);

  useEffect(() => {
    api<ViewConfig>("GET", "/api/config")
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  const load = useCallback(async () => {
    try {
      const [brainList, agentList, usageData] = await Promise.all([
        api<{ brains: Brain[] }>("GET", "/api/brains"),
        api<{ agents: Agent[] }>("GET", "/api/agents"),
        api<Usage>("GET", "/api/usage?days=31"),
      ]);
      setBrains(brainList.brains);
      setAgents(agentList.agents);
      setUsage(usageData);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn’t load brains.");
    }
  }, []);

  useEffect(() => {
    document.title = "Your brains";
    void load();
  }, [load]);

  const ordered = [...(brains ?? [])].sort((a, b) => (a.kind === "personal" ? -1 : b.kind === "personal" ? 1 : 0));
  const memoryCount = (brains ?? []).reduce((sum, brain) => sum + brain.memoryCount, 0);

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between bg-canvas/80 px-5 backdrop-blur-md dark:bg-canvas-dark/80">
        <a href="/" className="flex items-center gap-2 text-sm font-semibold text-slate-950 dark:text-white">
          <img src="/logo.png" alt="" width={22} height={22} className="rounded-md" />
          Make0 Brain
        </a>
        <ThemeButton />
      </header>

      <main className="mx-auto max-w-[1160px] px-5 pt-5 pb-16">
        <div className="mb-7 flex flex-wrap items-center gap-4">
          <div className="grid size-11 place-items-center rounded-2xl bg-gradient-to-br from-pink-200 to-violet-300 text-violet-950">
            <BrainIcon size={22} />
          </div>
          <div className="min-w-[200px] flex-1">
            <h1 className="text-[26px] font-bold tracking-tight text-slate-950 dark:text-white">Your brains</h1>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">Create a brain, then open it to add memories.</p>
          </div>
          <Button onClick={() => setEditing("new")}>
            <PlusIcon size={14} strokeWidth={2.5} />
            New brain
          </Button>
        </div>

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20.5rem] xl:grid-cols-[minmax(0,1fr)_23rem]">
          <div className="min-w-0">
            {error ? (
              <p className="py-16 text-center text-sm text-slate-500">{error}</p>
            ) : brains == null ? (
              <p className="py-16 text-center text-sm text-slate-500">Loading brains…</p>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
                <NewBrainCard onClick={() => setEditing("new")} />
                {ordered.map((brain) => (
                  <BrainCard
                    key={brain.id}
                    brain={brain}
                    reads={usage?.brains[brain.id]?.month.reads ?? 0}
                    onEdit={() => setEditing(brain)}
                    onDelete={() => setDeleting(brain)}
                  />
                ))}
              </div>
            )}
          </div>

          <aside className="min-w-0 overflow-hidden rounded-2xl border border-black/[0.08] bg-white lg:sticky lg:top-20 dark:border-white/10 dark:bg-panel-dark">
            <UsageStats memoryCount={memoryCount} points={usage?.total ?? []} month={usage?.month ?? { reads: 0, writes: 0, tokensIn: 0, tokensOut: 0 }}
              onExpand={(range, measure) => setActivity({ range, measure })}
            />
            <ConnectedApps agents={agents} brains={brains ?? []} usage={usage} onManage={setManaging} />
          </aside>
        </div>
      </main>

      <PageFooter config={config} brainCount={brains?.length ?? 0} memoryCount={memoryCount} />

      {editing ? (
        <BrainDialog
          brain={editing === "new" ? null : editing}
          agents={agents}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            toast(message);
            void load();
          }}
        />
      ) : null}
      {activity ? (
        <ActivityModal
          brains={ordered}
          agents={agents}
          initialRange={activity.range}
          initialMeasure={activity.measure}
          onClose={() => setActivity(null)}
        />
      ) : null}
      {managing ? (
        <AppAccessDialog
          agent={managing}
          brains={ordered}
          onClose={() => setManaging(null)}
          onSaved={() => {
            toast(`Access saved for ${managing.name}`);
            setManaging(null);
            void load();
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteBrainDialog
          brain={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            toast(`${deleting.name} deleted`);
            setDeleting(null);
            void load();
          }}
        />
      ) : null}
      <Toaster />
    </div>
  );
}

function NewBrainCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[204px] cursor-pointer flex-col items-center justify-center gap-2.5 rounded-[20px] border-[1.5px] border-dashed border-black/10 text-sm font-semibold text-slate-500 transition-colors hover:bg-white/60 hover:text-slate-950 dark:border-white/15 dark:text-slate-400 dark:hover:bg-white/[0.03] dark:hover:text-white"
    >
      <span className="grid size-11 place-items-center rounded-2xl bg-black/[0.04] dark:bg-white/[0.07]">
        <PlusIcon size={18} strokeWidth={2.5} />
      </span>
      New brain
    </button>
  );
}

function BrainCard({
  brain,
  reads,
  onEdit,
  onDelete,
}: {
  brain: Brain;
  reads: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menu]);
  const open = () => {
    location.href = brainHref(brain);
  };
  return (
    <article
      role="link"
      tabIndex={0}
      aria-label={`Open ${brain.name}`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter") open();
      }}
      className="group relative flex min-h-[204px] cursor-pointer flex-col rounded-[20px] border border-black/[0.08] bg-white p-[18px] shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgba(15,23,42,0.05),0_16px_40px_rgba(15,23,42,0.1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-950 dark:border-white/10 dark:bg-panel-dark dark:shadow-none dark:hover:border-white/20"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="grid size-11 place-items-center rounded-2xl border border-black/[0.06] bg-[#faf9f7] text-[22px] dark:border-white/[0.08] dark:bg-white/[0.04]">
          {brainEmoji(brain)}
        </span>
        <div className="flex items-center gap-1.5">
          {brain.kind === "personal" ? (
            <span className="rounded-full bg-black/[0.04] px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-white/[0.07] dark:text-slate-400">
              Default
            </span>
          ) : null}
          <button
            type="button"
            aria-label="Brain options"
            aria-expanded={menu}
            onClick={(event) => {
              event.stopPropagation();
              setMenu(!menu);
            }}
            className={cn(
              "grid size-8 cursor-pointer place-items-center rounded-lg text-slate-500 hover:bg-black/[0.05] hover:text-slate-950 dark:hover:bg-white/[0.08] dark:hover:text-white",
              menu ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
            )}
          >
            <MoreIcon />
          </button>
        </div>
      </div>
      {menu ? (
        <div
          onClick={(event) => event.stopPropagation()}
          className="absolute top-14 right-3.5 z-10 min-w-[160px] rounded-xl border border-black/[0.08] bg-white p-1 shadow-xl dark:border-white/10 dark:bg-[#1c2128]"
        >
          <MenuItem
            onClick={() => {
              setMenu(false);
              onEdit();
            }}
          >
            {brain.kind === "personal" ? "Edit description" : "Edit"}
          </MenuItem>
          {brain.kind !== "personal" ? (
            <MenuItem
              danger
              onClick={() => {
                setMenu(false);
                onDelete();
              }}
            >
              Delete
            </MenuItem>
          ) : null}
        </div>
      ) : null}
      <h2 className="mt-4 truncate text-base font-semibold tracking-tight text-slate-950 dark:text-white">{brain.name}</h2>
      <p className="mt-1.5 line-clamp-2 flex-1 text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
        {brain.description || (brain.kind === "personal" ? "Facts about you. Every app sees this unless you change it." : "No description yet.")}
      </p>
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-black/[0.06] pt-3 text-xs text-slate-500 tabular-nums dark:border-white/[0.08] dark:text-slate-400">
        <span>
          {plural(brain.memoryCount, "memory", "memories")}
          {reads > 0 ? <span className="text-slate-400"> · {reads.toLocaleString()} reads</span> : null}
        </span>
        {brain.agents.length === 0 ? (
          <span className="inline-flex items-center gap-1">
            <LockIcon size={12} />
            No apps
          </span>
        ) : (
          <span className="flex items-center" title={brain.agents.map((agent) => agent.name).join(", ")}>
            {brain.agents.slice(0, 3).map((agent, index) => (
              <AppMark
                key={agent.id}
                id={agent.id}
                name={agent.name}
                className={cn("size-6 rounded-md ring-2 ring-white dark:ring-panel-dark", index > 0 && "-ml-1.5")}
              />
            ))}
            {brain.agents.length > 3 ? <span className="ml-1.5 text-[11px]">+{brain.agents.length - 3}</span> : null}
          </span>
        )}
      </div>
    </article>
  );
}

function MenuItem({ children, onClick, danger }: { children: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "block w-full cursor-pointer rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]",
        danger ? "text-red-600 dark:text-red-400" : "text-slate-900 dark:text-slate-100",
      )}
    >
      {children}
    </button>
  );
}

const REPO_URL = "https://github.com/make0-official/brain-oss";

function FooterHeading({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-xs font-semibold text-slate-950 dark:text-white">{children}</h2>;
}

function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <li>
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-[13px] text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white">
        {children}
      </a>
    </li>
  );
}

function PageFooter({ config, brainCount, memoryCount }: { config: ViewConfig | null; brainCount: number; memoryCount: number }) {
  return (
    <footer className="mx-auto max-w-[1160px] px-5 pb-10">
      <HostedAdBanner />
      <div className="mt-8 grid gap-8 border-t border-black/[0.08] pt-8 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,0.7fr)] dark:border-white/10">
        <section className="min-w-0">
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="" width={22} height={22} className="rounded-md" />
            <span className="text-sm font-semibold text-slate-950 dark:text-white">Make0 Brain</span>
            {config ? (
              <span className="rounded-full border border-black/[0.08] px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 tabular-nums dark:border-white/10 dark:text-slate-400">
                v{config.version}
              </span>
            ) : null}
          </div>
          <p className="mt-3 max-w-xs text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
            One shared memory for Claude, Cursor, Codex, and every MCP app. Memories, versions, and embeddings stay in one SQLite file on this
            machine.
          </p>
          <p className="mt-3 text-xs text-slate-500 tabular-nums dark:text-slate-400">
            {plural(brainCount, "brain", "brains")} · {plural(memoryCount, "memory", "memories")} · MIT license
          </p>
        </section>

        <section className="min-w-0">
          <FooterHeading>This machine</FooterHeading>
          {config ? (
            <dl className="grid gap-2.5 text-[13px]">
              <div className="min-w-0">
                <dt className="text-[11px] text-slate-500 dark:text-slate-400">Database</dt>
                <dd className="mt-0.5 font-mono text-xs break-all text-slate-800 dark:text-slate-200">{config.database}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[11px] text-slate-500 dark:text-slate-400">Search</dt>
                <dd className="mt-0.5 truncate text-slate-800 dark:text-slate-200" title={`${config.embedder.model} + ${config.reranker.model}`}>
                  {config.embedder.model} + {config.reranker.name.toLowerCase()}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-[13px] text-slate-500 dark:text-slate-400">Loading…</p>
          )}
        </section>

        <section className="min-w-0">
          <FooterHeading>From the terminal</FooterHeading>
          <ul className="-mx-2 grid grid-cols-[minmax(0,1fr)] gap-0.5">
            {[
              ["Connect your apps", "init"],
              ["See which app reads which brain", "agents"],
              ["Back up every brain", "export --json brain.json"],
              ["All commands", "--help"],
            ].map(([label, args]) => {
              const command = `npx @make0-ai/brain ${args}`;
              return (
                <li key={args} className="min-w-0">
                  <button
                    type="button"
                    title={`Copy: ${command}`}
                    onClick={() => {
                      void navigator.clipboard.writeText(command).then(() => toast("Command copied"));
                    }}
                    className="group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-slate-700 dark:text-slate-300">{label}</span>
                      <code className="mt-0.5 block truncate font-mono text-[11px] text-slate-400">{command}</code>
                    </span>
                    <CopyIcon size={13} className="shrink-0 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="min-w-0">
          <FooterHeading>Links</FooterHeading>
          <ul className="grid gap-1.5">
            <FooterLink href={`${REPO_URL}#readme`}>Documentation</FooterLink>
            <FooterLink href={REPO_URL}>GitHub</FooterLink>
            <FooterLink href={`${REPO_URL}/issues`}>Report an issue</FooterLink>
            <FooterLink href="https://make0.ai">make0.ai</FooterLink>
          </ul>
        </section>
      </div>
    </footer>
  );
}

function ConnectedApps({
  agents,
  brains,
  usage,
  onManage,
}: {
  agents: Agent[];
  brains: Brain[];
  usage: Usage | null;
  onManage: (agent: Agent) => void;
}) {
  const [open, setOpen] = useState(false);
  const connected = agents.filter((agent) => agent.connected);
  const shown = connected.slice(0, 4);
  return (
    <section className="border-t border-black/[0.06] p-5 dark:border-white/[0.08]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight text-slate-950 dark:text-white">Connected apps</h2>
        <span className="text-xs text-slate-500 tabular-nums dark:text-slate-400">
          {agents.length === 0 ? "None yet" : `${connected.length} of ${agents.length} connected`}
        </span>
      </div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-black/[0.08] px-3 py-2.5 text-left transition-colors hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/[0.05]"
      >
        {shown.length > 0 ? (
          <span className="flex shrink-0 -space-x-1.5">
            {shown.map((agent) => (
              <AppMark key={agent.id} id={agent.id} name={agent.name} className="size-7 ring-2 ring-white dark:ring-panel-dark" />
            ))}
          </span>
        ) : null}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-slate-950 dark:text-white">
            {connected.length > 0 ? "Manage apps" : "Connect an app"}
          </span>
          <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400" title={connected.map((agent) => agent.name).join(", ")}>
            {connected.length > 0 ? connected.map((agent) => agent.name).join(", ") : "Claude, Cursor, Codex, and more"}
          </span>
        </span>
        <ChevronRightIcon size={14} className="shrink-0 text-slate-400" />
      </button>
      {open ? (
        <AppsModal
          agents={agents}
          brains={brains}
          usage={usage}
          onClose={() => setOpen(false)}
          onManage={(agent) => {
            setOpen(false);
            onManage(agent);
          }}
        />
      ) : null}
    </section>
  );
}

function AppsModal({
  agents,
  brains,
  usage,
  onClose,
  onManage,
}: {
  agents: Agent[];
  brains: Brain[];
  usage: Usage | null;
  onClose: () => void;
  onManage: (agent: Agent) => void;
}) {
  const names = (ids: string[]) => ids.map((id) => brains.find((brain) => brain.id === id)?.name).filter(Boolean).join(", ");
  const sorted = [...agents].sort((a, b) => Number(b.connected) - Number(a.connected));
  return (
    <Modal open onClose={onClose} size="lg" title="Connected apps" description="Pick an app to choose which brains it can read and write.">
      {sorted.length > 0 ? (
        <ul className="-mx-2 mb-4">
          {sorted.map((agent) => {
            const reads = usage?.clients.find((client) => client.id === agent.id)?.month.reads ?? 0;
            return (
              <li key={agent.id}>
                <button
                  type="button"
                  onClick={() => onManage(agent)}
                  className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                >
                  <AppMark id={agent.id} name={agent.name} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-slate-950 dark:text-white">{agent.name}</span>
                      <span
                        className={cn("size-1.5 shrink-0 rounded-full", agent.connected ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600")}
                        title={agent.connected ? "Connected" : "Not set up"}
                      />
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-slate-500 tabular-nums dark:text-slate-400">
                      {agent.connected
                        ? `${names(agent.brainIds) || "No brains"}${reads ? ` · ${reads.toLocaleString()} reads this month` : ""}`
                        : "Not set up · run init"}
                    </span>
                  </span>
                  <ChevronRightIcon size={14} className="text-slate-400" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="rounded-xl border border-black/[0.08] bg-[#faf9f7] p-3 dark:border-white/10 dark:bg-white/[0.04]">
        <p className="text-[13px] font-semibold tracking-tight text-slate-950 dark:text-white">Connect an app</p>
        <p className="mt-1 mb-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Adds Make0 Brain to Claude, Cursor, Codex, and other MCP apps on this machine. Restart the app afterwards.
        </p>
        <CopyField value={INIT_COMMAND} />
      </div>
    </Modal>
  );
}

function BrainDialog({
  brain,
  agents,
  onClose,
  onSaved,
}: {
  brain: Brain | null;
  agents: Agent[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const personal = brain?.kind === "personal";
  const available = agents.filter((agent) => agent.detected || agent.lastSeenAt);
  const [name, setName] = useState(brain?.name ?? "");
  const [emoji, setEmoji] = useState(brain?.emoji ?? "");
  const [description, setDescription] = useState(brain?.description ?? "");
  const [agentIds, setAgentIds] = useState<string[]>(() => available.filter((agent) => agent.connected).map((agent) => agent.id));
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const withAccess = (brain?.agents ?? []).map((entry) => {
    const brainIds = agents.find((agent) => agent.id === entry.id)?.brainIds ?? [brain!.id];
    return { ...entry, remaining: brainIds.filter((id) => id !== brain!.id) };
  });
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!personal && !name.trim()) {
      setError("Give the brain a name.");
      return;
    }
    setSaving(true);
    setError(null);
    const payload: Record<string, unknown> = { description: description.trim() || null };
    if (!personal) {
      payload.name = name.trim();
      payload.emoji = emoji || null;
    }
    if (!brain) payload.agentIds = agentIds;
    try {
      const saved = brain
        ? await api<Brain>("PATCH", `/api/brains/${enc(brain.id)}`, payload)
        : await api<Brain>("POST", "/api/brains", payload);
      for (const entry of withAccess) {
        if (!removedIds.includes(entry.id)) continue;
        await api("PUT", `/api/agents/${enc(entry.id)}/brains`, { brainIds: entry.remaining });
      }
      onSaved(brain ? "Brain updated" : `${saved.name} created`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn’t save that brain.");
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={brain ? (personal ? "Describe your personal brain" : "Edit brain") : "New brain"}
      description={
        brain
          ? personal
            ? "A short note, and which apps can read it."
            : "Icon, name, a short note, and which apps can read it."
          : "Keep work, projects, or clients apart. Apps only see the brains you give them."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="brain-form" disabled={saving}>
            {saving ? "Saving…" : brain ? "Save" : "Create brain"}
          </Button>
        </>
      }
    >
      <form id="brain-form" onSubmit={(event) => void submit(event)} className="grid min-w-0 gap-4">
        {!personal ? (
          <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-2.5">
            <EmojiPicker value={emoji} onChange={setEmoji} />
            <Field label="Name">
              <input autoFocus className={inputClass} maxLength={80} placeholder="Work" value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
          </div>
        ) : null}
        <Field label="Description">
          <input
            autoFocus={personal}
            className={inputClass}
            maxLength={80}
            placeholder="What this brain is for"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        {!brain ? (
          <div className="grid min-w-0 gap-2">
            <p className="text-xs font-semibold text-slate-900 dark:text-white">Give access to</p>
            {available.map((agent) => (
              <ToggleRow
                key={agent.id}
                visual={<AppMark id={agent.id} name={agent.name} className="size-[30px]" />}
                label={agent.name}
                tag={agent.id}
                hint={agent.connected ? undefined : "Not set up yet"}
                checked={agentIds.includes(agent.id)}
                onChange={(checked) =>
                  setAgentIds((current) => (checked ? [...current, agent.id] : current.filter((id) => id !== agent.id)))
                }
              />
            ))}
            <CustomAgentHelp open={available.length === 0} brainName={name.trim() || "Work"} agents={agents} />
          </div>
        ) : (
          <div className="grid min-w-0 gap-2">
            <p className="text-xs font-semibold text-slate-900 dark:text-white">Apps with access</p>
            {withAccess.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">No apps yet. Give one access from Connected apps.</p>
            ) : (
              <ul className="grid gap-1.5">
                {withAccess.map((entry) => {
                  const removed = removedIds.includes(entry.id);
                  const hint = removed
                    ? entry.remaining.length > 0
                      ? "Loses access when you save."
                      : "Loses access when you save. It will have no brains."
                    : null;
                  return (
                    <li
                      key={entry.id}
                      className="flex min-w-0 items-center gap-2.5 rounded-xl border border-black/[0.08] px-2.5 py-2 dark:border-white/10"
                    >
                      <AppMark id={entry.id} name={entry.name} className={cn("size-[30px]", removed && "opacity-40")} />
                      <div className="min-w-0 flex-1">
                        <p className={cn("flex min-w-0 items-center gap-1.5 text-sm font-medium text-slate-900 dark:text-white", removed && "line-through opacity-50")}>
                          <span className="truncate">{entry.name}</span>
                          <code className="shrink-0 rounded bg-black/[0.05] px-1 text-[10px] font-normal text-slate-500 dark:bg-white/[0.08] dark:text-slate-400">
                            {entry.id}
                          </code>
                        </p>
                        {hint ? <p className="mt-0.5 text-[11px] break-words text-slate-500 dark:text-slate-400">{hint}</p> : null}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={cn("shrink-0", !removed && "text-red-700 dark:text-red-400")}
                        onClick={() =>
                          setRemovedIds((current) => (removed ? current.filter((id) => id !== entry.id) : [...current, entry.id]))
                        }
                      >
                        {removed ? "Undo" : "Remove"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        <ErrorText>{error}</ErrorText>
      </form>
    </Modal>
  );
}

function CustomAgentHelp({ open, brainName, agents }: { open: boolean; brainName: string; agents: Agent[] }) {
  const ids = agents.map((agent) => agent.id);
  const [agentId, setAgentId] = useState(() => agents.find((agent) => !agent.detected && agent.lastSeenAt)?.id ?? ids[0] ?? "");
  return (
    <details open={open} className="group min-w-0 rounded-xl border border-black/10 px-3 dark:border-white/10">
      <summary className="cursor-pointer py-2.5 text-[13px] font-semibold text-slate-950 dark:text-white">
        {open ? "No agents found. Connect yours" : "Using another agent?"}
      </summary>
      <ol className="mb-3 grid min-w-0 list-decimal gap-3 pl-5 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
        <li className="min-w-0">
          Add Make0 Brain to your agent’s MCP config:
          <div className="mt-1.5">
            <CopyField value={MCP_CONFIG} multiline />
          </div>
        </li>
        <li className="min-w-0">
          Restart the agent. Once it connects, it shows up in this list and under Connected apps with its id, so you can tick it here.
        </li>
        <li className="min-w-0">
          Or give it this brain from a terminal after you create it:
          {ids.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-slate-500 dark:text-slate-400">Agent id:</span>
              {ids.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={id === agentId}
                  onClick={() => setAgentId(id)}
                  className={cn(
                    "cursor-pointer rounded-md px-1.5 py-0.5 font-mono text-[11px]",
                    id === agentId
                      ? "bg-slate-950 text-white dark:bg-white dark:text-slate-950"
                      : "bg-black/[0.05] text-slate-700 hover:bg-black/[0.08] dark:bg-white/[0.08] dark:text-slate-300",
                  )}
                >
                  {id}
                </button>
              ))}
            </div>
          ) : null}
          <div className="mt-1.5">
            <CopyField value={`npx @make0-ai/brain agents grant ${agentId || "<agent-id>"} ${shellQuote(brainName)}`} multiline />
          </div>
          {ids.length === 0 ? (
            <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
              Your agent’s id appears here after it connects once. You can also run <code className="font-mono">npx @make0-ai/brain agents</code> to list ids.
            </span>
          ) : null}
        </li>
      </ol>
    </details>
  );
}

function ToggleRow({
  visual,
  label,
  tag,
  hint,
  checked,
  onChange,
}: {
  visual: ReactNode;
  label: string;
  tag?: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-black/10 px-3 py-2.5 hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/[0.04]">
      {visual}
      <span className="min-w-0 flex-1 text-[13px] font-medium text-slate-950 dark:text-white">
        {label}
        {tag ? (
          <code className="ml-1.5 rounded bg-black/[0.05] px-1 py-px font-mono text-[10px] font-normal text-slate-500 dark:bg-white/[0.08] dark:text-slate-400">
            {tag}
          </code>
        ) : null}
        {hint ? <small className="block text-[11px] font-normal text-slate-500 dark:text-slate-400">{hint}</small> : null}
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-slate-950 dark:accent-white" />
    </label>
  );
}

function AppAccessDialog({
  agent,
  brains,
  onClose,
  onSaved,
}: {
  agent: Agent;
  brains: Brain[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(agent.brainIds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    try {
      await api("PUT", `/api/agents/${enc(agent.id)}/brains`, { brainIds: selected });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn’t save access.");
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2.5">
          <AppMark id={agent.id} name={agent.name} />
          {agent.name}
          <code className="rounded bg-black/[0.05] px-1.5 py-0.5 font-mono text-[11px] font-normal text-slate-500 dark:bg-white/[0.08] dark:text-slate-400">
            {agent.id}
          </code>
        </span>
      }
      description={
        agent.connected
          ? `Choose which brains ${agent.name} can read and write.`
          : `${agent.name} isn’t set up yet. Run init, then restart it. These choices apply once it connects.`
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save access"}
          </Button>
        </>
      }
    >
      <div className="grid gap-2">
        {brains.map((brain) => (
          <ToggleRow
            key={brain.id}
            visual={
              <span className="grid size-[30px] place-items-center rounded-lg border border-black/[0.06] bg-[#faf9f7] text-[15px] dark:border-white/[0.08] dark:bg-white/[0.04]">
                {brainEmoji(brain)}
              </span>
            }
            label={brain.name}
            hint={plural(brain.memoryCount, "memory", "memories")}
            checked={selected.includes(brain.id)}
            onChange={(checked) => setSelected((current) => (checked ? [...current, brain.id] : current.filter((id) => id !== brain.id)))}
          />
        ))}
        {selected.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">No brains selected. {agent.name} won’t be able to read or save memories.</p>
        ) : null}
        {!agent.connected ? (
          <div className="mt-2">
            <CopyField value={INIT_COMMAND} />
          </div>
        ) : null}
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}

function DeleteBrainDialog({ brain, onClose, onDeleted }: { brain: Brain; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = brain.memoryCount > 0;
  const remove = async () => {
    setBusy(true);
    try {
      await api("DELETE", `/api/brains/${enc(brain.id)}`);
      onDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn’t delete that brain.");
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Delete ${brain.name}?`}
      description={
        blocked
          ? `This brain still has ${plural(brain.memoryCount, "memory", "memories")}. Delete them first, then empty the recycle bin.`
          : "Apps lose access to it. This can’t be undone."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {blocked ? "Got it" : "Cancel"}
          </Button>
          {!blocked ? (
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              {busy ? "Deleting…" : "Delete brain"}
            </Button>
          ) : null}
        </>
      }
    >
      {error ? <ErrorText>{error}</ErrorText> : undefined}
    </Modal>
  );
}
