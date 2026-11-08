import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Plus, Square } from 'lucide-react';
import type { AgentId, AgentProvider } from '@syncode/protocol/events';
import type { FleetEntry } from '@syncode/protocol/wire';
import type { RoomApi, SavedConfig } from './api.js';
import { ensurePresetConfig } from './ensurePreset.js';
import { STATUS_META, statusText } from './fleetStatus.js';
import { PRESETS, uniqueName } from './presets.js';
import type { Preset } from './presets.js';

export interface FleetStripProps {
  fleet: FleetEntry[];
  focusedAgentId: AgentId | null;
  configs: readonly SavedConfig[];
  api: Pick<RoomApi, 'saveConfig'>;
  /** Called with a config this strip just created, so the library stays current. */
  onConfigSaved: (config: SavedConfig) => void;
  onFocusAgent: (agentId: AgentId | null) => void;
  onSpawnAgent: (params: {
    displayName: string;
    provider: AgentProvider;
    model: string | null;
    configName?: string;
  }) => void;
  onStopAgent: (agentId: AgentId) => void;
  onOpenAgentChat: (agentId: AgentId) => void;
}

/** How long to wait for a spawned agent to show up before saying so. */
export const SPAWN_HINT_MS = 4000;

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg';

const SMALL_BTN = `inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium ${FOCUS_RING}`;

/**
 * The live agents, plus one-click "New agent" presets.
 *
 * Liveness comes only from the `fleet` prop (the transient server frame);
 * nothing here caches it. Spawning is fire-and-forget over the socket and the
 * server may refuse it (a non-driver, the fleet size limit) - that refusal
 * arrives later as the shell's error banner, so this strip never shows an
 * optimistic "spawned" state. If no agent with the requested name appears
 * within a few seconds it says so, without pretending to know why.
 *
 * Narrow widths: the chips scroll sideways (`overflow-x-auto`, `shrink-0`
 * chips) so Stop is never clipped; the preset buttons wrap beneath.
 */
export function FleetStrip({
  fleet,
  focusedAgentId,
  configs,
  api,
  onConfigSaved,
  onFocusAgent,
  onSpawnAgent,
  onStopAgent,
  onOpenAgentChat,
}: FleetStripProps): JSX.Element {
  const [problem, setProblem] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  // The display name we asked for and the fleet it was asked against.
  const pending = useRef<{ name: string; known: Set<string> } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // When the agent we asked for appears, focus it. The spawn call returns no
  // id (the server mints it), so the name is all we have to match on.
  useEffect(() => {
    const wait = pending.current;
    if (wait === null) return;
    const arrived = fleet.find((f) => f.displayName === wait.name && !wait.known.has(f.agentId));
    if (arrived === undefined) return;
    pending.current = null;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setHint(null);
    onFocusAgent(arrived.agentId);
  }, [fleet, onFocusAgent]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  async function spawnPreset(preset: Preset): Promise<void> {
    setProblem(null);
    setHint(null);
    setBusy(true);
    try {
      const ensured = await ensurePresetConfig(preset, configs, api);
      if (!ensured.ok) {
        setProblem(ensured.problems.length > 0 ? ensured.problems : [ensured.message]);
        return;
      }
      if (ensured.data.created) onConfigSaved(ensured.data.config);
      const displayName = uniqueName(
        preset.name,
        fleet.map((f) => f.displayName),
      );
      pending.current = { name: displayName, known: new Set(fleet.map((f) => f.agentId)) };
      onSpawnAgent({ displayName, provider: 'anthropic', model: null, configName: ensured.data.config.name });
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (pending.current === null) return;
        pending.current = null;
        setHint(
          'No new agent has appeared yet. Only the driver can change the fleet, and the fleet has a size limit - check the error banner.',
        );
      }, SPAWN_HINT_MS);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Agents" className="flex min-w-0 flex-col gap-1 border-b border-border bg-surface px-2 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <ul aria-label="Agent fleet" className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5">
          {fleet.length === 0 && (
            <li className="shrink-0 text-xs text-fg-muted">No agents yet - add one, or build a workflow below.</li>
          )}
          {fleet.map((agent) => {
            const meta = STATUS_META[agent.status];
            const Icon = meta.icon;
            const focused = agent.agentId === focusedAgentId;
            const awaiting = agent.status === 'awaiting_approval';
            return (
              <li
                key={agent.agentId}
                data-agent-id={agent.agentId}
                aria-current={focused ? 'true' : undefined}
                className={`flex shrink-0 items-center gap-1 rounded-md border py-0.5 pl-2 pr-1 ${
                  awaiting
                    ? 'border-warn bg-warn/10 ring-1 ring-warn'
                    : agent.status === 'error'
                      ? 'border-danger bg-danger/5'
                      : focused
                        ? 'border-accent bg-surface-2'
                        : 'border-border bg-bg'
                }`}
              >
                <Icon size={14} strokeWidth={2} className={`shrink-0 ${meta.tone} ${meta.iconClassName}`} aria-hidden="true" />
                <button
                  type="button"
                  onClick={() => onFocusAgent(agent.agentId)}
                  aria-label={`Focus ${agent.displayName}`}
                  className={`max-w-[10rem] truncate rounded text-xs font-medium text-fg ${FOCUS_RING}`}
                >
                  {agent.displayName}
                </button>
                <span role="status" className={`shrink-0 text-xs ${meta.tone}`}>
                  {statusText(agent)}
                </span>
                <button
                  type="button"
                  aria-label={`Open chat with ${agent.displayName}`}
                  title="Open chat"
                  onClick={() => {
                    onFocusAgent(agent.agentId);
                    onOpenAgentChat(agent.agentId);
                  }}
                  className={`${SMALL_BTN} border-transparent text-fg-muted hover:bg-surface-2 hover:text-fg`}
                >
                  <MessageSquare size={13} aria-hidden="true" />
                </button>
                {agent.status !== 'stopped' && (
                  <button
                    type="button"
                    aria-label={`Stop ${agent.displayName}`}
                    onClick={() => onStopAgent(agent.agentId)}
                    className={`${SMALL_BTN} border-danger/45 text-danger hover:bg-danger/10`}
                  >
                    <Square size={11} aria-hidden="true" />
                    Stop
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        <div className="flex shrink-0 flex-wrap items-center gap-1" role="group" aria-label="New agent">
          <span className="text-xs text-fg-muted">New agent</span>
          {PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              disabled={busy}
              title={`Adds an agent labelled "${preset.name}". Its role prompt is applied when it runs inside a workflow.`}
              aria-label={`New ${preset.name} agent`}
              onClick={() => void spawnPreset(preset)}
              className={`${SMALL_BTN} border-border-strong bg-surface-2 text-fg hover:bg-muted disabled:opacity-50`}
            >
              <Plus size={12} aria-hidden="true" />
              {preset.name}
            </button>
          ))}
        </div>
      </div>

      {problem !== null && (
        <ul role="alert" className="list-disc pl-5 text-xs text-danger">
          {problem.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {hint !== null && (
        <p role="status" className="text-xs text-fg-muted">
          {hint}
        </p>
      )}
    </section>
  );
}
