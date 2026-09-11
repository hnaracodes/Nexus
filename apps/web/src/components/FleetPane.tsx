import { useState, type FormEvent } from 'react';
import { AlertOctagon, Circle, Loader2, Plus, ShieldAlert, XCircle } from 'lucide-react';
import type { AgentId, AgentProvider } from '@nexus/protocol/events';
import { AGENT_PROVIDERS } from '@nexus/protocol/events';
import type { AgentStatus, FleetEntry } from '@nexus/protocol/wire';
import { Button } from './Button.js';

/**
 * The fleet sidebar (phase 12, F5). Renders `RoomView.fleet` — the transient,
 * server-pushed `FleetEntry[]` (see `wire.ts`'s `fleet` frame) — as one row per
 * agent with enough to steer by: who it is, which provider/model, and what
 * it's doing right now.
 *
 * This component never touches the socket. Spawn and stop are raised as
 * `onSpawn`/`onStop` so the integrator can translate them into `spawn_agent`
 * / `stop_agent` frames (the server mints the id — D2 in the phase-12 plan —
 * so `onSpawn` never invents one). `focusedAgentId`/`onFocus` are a controlled
 * pair, the same shape as `FileTree`'s `selectedPath`/`onSelect`: which agent's
 * transcript is on screen is LOCAL UI STATE, exactly like the workspace pane's
 * pin/follow — no new room state, no arbitration, no round trip — so this
 * component reports the click and leaves where that state actually lives to
 * whoever renders both this pane and the transcript pane beside it.
 *
 * D5 in the plan is why `status` here can never be reconstructed from the log:
 * membership survives a restart via `agent_spawned`/`agent_stopped`, but
 * whether an agent is mid-turn, blocked on a human, or errored is liveness,
 * not history — only the live `fleet` frame can say it, which is exactly why
 * this component takes `FleetEntry[]` as a prop instead of deriving it.
 */
export interface FleetPaneProps {
  agents: FleetEntry[];
  /** The agent whose transcript is currently on screen, or none. */
  focusedAgentId: AgentId | null;
  onFocus: (agentId: AgentId) => void;
  onSpawn: (params: { displayName: string; provider: AgentProvider; model: string | null }) => void;
  onStop: (agentId: AgentId) => void;
}

// Anthropic is the ratified first provider (CLAUDE.md §4) — the sensible
// default selection when the spawn form opens, not a claim about `AGENT_PROVIDERS`'
// ordering, which `noUncheckedIndexedAccess` won't let us index into blindly anyway.
const DEFAULT_PROVIDER: AgentProvider = 'anthropic';

const PROVIDER_LABEL: Record<AgentProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

/**
 * `awaiting_approval` gets its own icon, its own tone AND — critically — a row
 * background and left bar (applied where the row renders, not here) so it does
 * not read as "a slightly different colour of the same row" at twenty entries.
 * `error` gets a lighter version of the same treatment: also actionable, never
 * as loud as the state that is actively blocking a human.
 */
const STATUS_META: Record<AgentStatus, { label: string; icon: typeof Circle; tone: string; iconClassName: string }> = {
  idle: { label: 'Idle', icon: Circle, tone: 'text-fg-muted', iconClassName: '' },
  working: { label: 'Working', icon: Loader2, tone: 'text-accent', iconClassName: 'animate-spin' },
  awaiting_approval: {
    label: 'Needs approval',
    icon: ShieldAlert,
    tone: 'text-warn',
    iconClassName: 'animate-nexus-pulse',
  },
  error: { label: 'Error', icon: AlertOctagon, tone: 'text-danger', iconClassName: '' },
  stopped: { label: 'Stopped', icon: XCircle, tone: 'text-fg-muted', iconClassName: '' },
};

/**
 * The label a screen reader announces and a sighted user reads — colour is
 * never the only carrier (MASTER.md's rule, restated in the phase-12 plan as a
 * governance requirement: `awaiting_approval` is the state where the fleet is
 * blocked on a human, so it must be findable by TEXT, not just by CSS class).
 */
function statusText(agent: FleetEntry): string {
  const meta = STATUS_META[agent.status];
  if (agent.status === 'awaiting_approval' && agent.pendingApprovals > 0) {
    return `${meta.label} · ${agent.pendingApprovals} pending`;
  }
  return meta.label;
}

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

export function FleetPane({ agents, focusedAgentId, onFocus, onSpawn, onStop }: FleetPaneProps): JSX.Element {
  const [spawning, setSpawning] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [provider, setProvider] = useState<AgentProvider>(DEFAULT_PROVIDER);
  const [model, setModel] = useState('');

  function cancelSpawn(): void {
    setSpawning(false);
    setDisplayName('');
    setProvider(DEFAULT_PROVIDER);
    setModel('');
  }

  function submitSpawn(event: FormEvent): void {
    event.preventDefault();
    const trimmedName = displayName.trim();
    if (trimmedName === '') return; // never spawn a nameless agent — it would be unattributable in the roster
    onSpawn({ displayName: trimmedName, provider, model: model.trim() === '' ? null : model.trim() });
    cancelSpawn();
  }

  /**
   * `w-full min-w-0` on the root is load-bearing, and `border-l` is gone.
   *
   * This pane was built as a RIGHT-HAND column with its own left border and
   * whatever width the room layout gave it. Phase 17a moved it into the 260px
   * side bar, where it is a flex item — and a flex item defaults to
   * `min-width: auto`, so it sized itself to its content, overflowed, and was
   * clipped by the side bar's `overflow-hidden`. The "Add agent" button and
   * every row's "Stop" button were sliced in half and unreachable: the fleet
   * was legible but not operable, which for a governance surface is the wrong
   * half to lose. Found by opening it, not by a test — the rows render
   * correctly in jsdom, which has no layout.
   *
   * The row markup below already handles narrow widths properly (min-w-0 plus
   * truncate on the label, shrink-0 on the icon and the status). It never got
   * the chance, because the container never accepted a width.
   *
   * The left border went with it: the side bar draws its own `border-r`, and
   * two borders in a 260px column is one too many.
   */
  return (
    <div className="flex h-full w-full min-w-0 min-h-0 flex-col bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Fleet</h2>
        {!spawning && (
          <Button variant="secondary" size="sm" onClick={() => setSpawning(true)}>
            <Plus size={14} aria-hidden="true" />
            Add agent
          </Button>
        )}
      </div>

      {spawning && (
        <form onSubmit={submitSpawn} className="flex flex-col gap-2 border-b border-border p-3 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-fg-muted">Display name</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              className={`min-h-11 rounded border border-border-strong bg-bg px-2 py-1 text-fg ${FOCUS_RING}`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-fg-muted">Provider</span>
            <select
              value={provider}
              onChange={(event) => setProvider(event.target.value as AgentProvider)}
              className={`min-h-11 rounded border border-border-strong bg-bg px-2 py-1 text-fg ${FOCUS_RING}`}
            >
              {AGENT_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-fg-muted">Model (optional)</span>
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="Account default"
              className={`min-h-11 rounded border border-border-strong bg-bg px-2 py-1 text-fg ${FOCUS_RING}`}
            />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={cancelSpawn}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm">
              Spawn
            </Button>
          </div>
        </form>
      )}

      <ul aria-label="Agent fleet" className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
        {agents.map((agent) => {
          const meta = STATUS_META[agent.status];
          const Icon = meta.icon;
          const isFocused = agent.agentId === focusedAgentId;
          const isStopped = agent.status === 'stopped';
          const isAwaiting = agent.status === 'awaiting_approval';
          const isError = agent.status === 'error';

          return (
            <li
              key={agent.agentId}
              className={`flex items-center gap-1 rounded-md border-l-[3px] pr-1 ${
                isAwaiting ? 'border-warn bg-warn/10' : isError ? 'border-danger bg-danger/5' : 'border-transparent'
              }`}
            >
              <button
                type="button"
                onClick={() => onFocus(agent.agentId)}
                aria-label={`Focus ${agent.displayName}'s transcript`}
                aria-current={isFocused ? 'true' : undefined}
                className={`flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left ${FOCUS_RING} ${
                  isFocused ? 'bg-surface-2' : 'hover:bg-surface-2'
                }`}
              >
                <Icon size={16} strokeWidth={2} className={`shrink-0 ${meta.tone} ${meta.iconClassName}`} aria-hidden="true" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium text-fg">{agent.displayName}</span>
                  <span className="truncate text-xs text-fg-muted">
                    <span>{PROVIDER_LABEL[agent.provider]}</span>
                    {' · '}
                    <span>{agent.model ?? 'default model'}</span>
                  </span>
                </span>
                <span role="status" className={`shrink-0 text-right text-xs font-medium ${meta.tone}`}>
                  {statusText(agent)}
                  {agent.queuedPrompts > 0 && (
                    <span className="block font-normal text-fg-muted">{agent.queuedPrompts} queued</span>
                  )}
                </span>
              </button>
              {/* shrink-0: the Stop button is the one thing in this row that
                  must never be shaved. It is how a person halts an agent, and
                  a governance control that is present but clipped is worse
                  than absent — it looks available and is not. The label beside
                  it truncates instead, which is what `min-w-0` above unlocks. */}
              {!isStopped && (
                <span className="shrink-0">
                  <Button variant="danger" size="sm" aria-label={`Stop ${agent.displayName}`} onClick={() => onStop(agent.agentId)}>
                    Stop
                  </Button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
