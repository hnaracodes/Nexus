import {
  AlertOctagon,
  CheckCircle2,
  CircleDashed,
  Clock,
  Loader2,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import type { AgentId } from '@syncode/protocol/events';
import type { AgentStatus, FleetEntry } from '@syncode/protocol/wire';
import type { Graph } from './graph.js';

/**
 * The live layer over the canvas (phase 14, unit H4). `graph.ts` is the
 * static model — nodes and edges, no liveness. This file answers the one
 * question that model cannot: what is happening to each node RIGHT NOW.
 *
 * TWO RULES, from the plan, both load-bearing:
 *
 * 1. LIVENESS comes from the transient `fleet` frame; MEMBERSHIP comes from
 *    the log. This component takes `fleet: FleetEntry[]` exactly as
 *    `FleetPane` does — never derived, never cached, never a second store.
 *    Do not build a third source of truth beside `presence`/`fleet`.
 *
 * 2. `awaiting_approval` must be the loudest state on the canvas. A user can
 *    draw twelve nodes with a drag, and twelve pending approvals that look
 *    like twelve idle nodes is the governance failure this whole phase exists
 *    to prevent.
 *
 * WHY `nodeAgentIds` is a PROP, not something this file derives: a workflow
 * node names a saved CONFIG (`graph.ts`'s `Node.configName`), and nothing
 * stops a graph from using the same config for two different nodes (e.g. two
 * "code reviewer" nodes in parallel) — so a node cannot be matched to a
 * `FleetEntry` by config name, provider or display name without risking a
 * collision. The one place that actually knows which real `AgentId` a node
 * became is the caller that started the run (`workflowRunner.ts`'s
 * `WorkflowRun.nodeAgentIds`, server-side) — this component consumes that
 * mapping rather than guessing at one, the same way `FleetPane` consumes
 * `focusedAgentId` instead of deriving "which agent is focused" itself.
 */

export type RunNodeStatus = 'not_started' | 'waiting' | AgentStatus;

export interface NodeRunState {
  status: RunNodeStatus;
  /** Only ever nonzero when `status === 'awaiting_approval'`. */
  pendingApprovals: number;
}

const NOT_SPAWNED: NodeRunState = { status: 'not_started', pendingApprovals: 0 };
const WAITING: NodeRunState = { status: 'waiting', pendingApprovals: 0 };

/**
 * Per-node live state, derived from the graph's edges, the transient fleet
 * snapshot, and the caller-supplied node→agent mapping. Exported standalone
 * (no React) so the decisions below are unit-testable without a DOM.
 */
export function computeRunStates(
  graph: Graph,
  fleet: readonly FleetEntry[],
  nodeAgentIds: ReadonlyMap<string, AgentId>,
): Map<string, NodeRunState> {
  const states = new Map<string, NodeRunState>();

  // No `fleet` frame has EVER arrived — `RoomView.fleet` starts as `[]`
  // (store.ts's `EMPTY_VIEW`) and only a live push ever changes that. With no
  // liveness observed at all, claiming any node is "waiting" on a real,
  // in-flight dependency would be a fact we do not have — 'not_started' is
  // the honest label for "nothing is known to be running".
  if (fleet.length === 0) {
    for (const node of graph.nodes) states.set(node.id, NOT_SPAWNED);
    return states;
  }

  const fleetById = new Map(fleet.map((entry) => [entry.agentId, entry]));
  const hasIncomingEdge = new Set(graph.edges.map((edge) => edge.to));

  for (const node of graph.nodes) {
    const agentId = nodeAgentIds.get(node.id);

    if (agentId !== undefined) {
      const live = fleetById.get(agentId);
      // Assigned but not yet reflected in a `fleet` push: `workflowRunner.ts`'s
      // `trySpawn` commits `agent_spawned` and calls `handle.submit()` in the
      // SAME tick, so the agent is already running in truth — reporting
      // 'working' says what is actually happening rather than falling back to
      // a generic default that would read as "hasn't started".
      states.set(node.id, live === undefined ? { status: 'working', pendingApprovals: 0 } : {
        status: live.status,
        pendingApprovals: live.status === 'awaiting_approval' ? live.pendingApprovals : 0,
      });
      continue;
    }

    // Not yet spawned. A node with no incoming edge has nothing to wait ON —
    // calling it "waiting" would name a dependency that does not exist, so it
    // is simply not started yet. A node WITH an incoming edge and no agent id
    // IS waiting on that edge: `workflowRunner.poll()` spawns a node the
    // instant its upstream settles, in the very call that notices the
    // upstream finished (that file's own "PULL, NOT PUSH" comment) — so an
    // unassigned node with a real upstream edge is, by construction, still
    // blocked on it.
    states.set(node.id, hasIncomingEdge.has(node.id) ? WAITING : NOT_SPAWNED);
  }

  return states;
}

interface StatusMeta {
  label: string;
  icon: typeof CircleDashed;
  tone: string;
  iconClassName: string;
}

/**
 * `awaiting_approval` gets its own tone, its own pulsing icon AND a heavier
 * badge treatment (applied where it renders, not here) so it does not read as
 * "a slightly different colour of the same badge" at twelve nodes and a
 * zoomed-out canvas — mirrors `FleetPane.tsx`'s identical `STATUS_META`.
 * `idle` is labelled "Done" here, not "Idle": a workflow node's agent is
 * spawned fresh with exactly one prompt (`workflowRunner.ts`'s module
 * comment), so its first `agent_idle` IS its completion, not a pause between
 * turns the way it would be on a long-lived hand-spawned agent.
 */
const STATUS_META: Record<RunNodeStatus, StatusMeta> = {
  not_started: { label: 'Not started', icon: CircleDashed, tone: 'text-fg-muted', iconClassName: '' },
  waiting: { label: 'Waiting on upstream', icon: Clock, tone: 'text-fg-muted', iconClassName: '' },
  idle: { label: 'Done', icon: CheckCircle2, tone: 'text-success', iconClassName: '' },
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

/** The label a screen reader announces and a sighted user reads — colour is
 *  never the only carrier (plan: "distinguishable by ACCESSIBLE TEXT, not
 *  colour alone"). Mirrors `FleetPane.tsx`'s identical `statusText`. */
function statusLabel(state: NodeRunState): string {
  const meta = STATUS_META[state.status];
  if (state.status === 'awaiting_approval' && state.pendingApprovals > 0) {
    return `${meta.label} · ${state.pendingApprovals} pending`;
  }
  return meta.label;
}

export interface RunOverlayProps {
  graph: Graph;
  /** The room's transient fleet snapshot — `RoomView.fleet`, unmodified. */
  fleet: FleetEntry[];
  /** Node id → the real agent id running it, once spawned. Empty (the
   *  default) before any run has started. */
  nodeAgentIds?: ReadonlyMap<string, AgentId>;
}

const NO_AGENTS: ReadonlyMap<string, AgentId> = new Map();

/**
 * One status badge per node, absolutely positioned at that node's canvas
 * coordinates. A sibling layer to whatever renders the static graph (H3's
 * `Canvas`/`NodeCard`, not yet built as of this file) — `pointer-events-none`
 * throughout because this overlay only reports state, it never captures a
 * drag or a click meant for the node underneath it.
 *
 * The exact offset from `(node.x, node.y)` is provisional: it anchors to the
 * node's own coordinate, the same point a node card will render at, but this
 * file cannot know a real card's rendered box (jsdom has no layout either —
 * plan landmine 1) and may need a pixel tweak once H3 lands.
 */
export function RunOverlay({ graph, fleet, nodeAgentIds = NO_AGENTS }: RunOverlayProps): JSX.Element {
  const states = computeRunStates(graph, fleet, nodeAgentIds);

  return (
    <div className="pointer-events-none absolute inset-0" aria-label="Workflow run status">
      {graph.nodes.map((node) => {
        const state = states.get(node.id) ?? NOT_SPAWNED;
        const meta = STATUS_META[state.status];
        const Icon = meta.icon;
        const isAwaiting = state.status === 'awaiting_approval';

        return (
          <div
            key={node.id}
            data-node-id={node.id}
            data-run-status={state.status}
            className="absolute flex flex-col items-start gap-0.5"
            style={{ left: node.x, top: node.y }}
          >
            <span className="truncate text-xs font-medium text-fg">{node.displayName}</span>
            <span
              role="status"
              // 'assertive' interrupts, matching `AgentActivity.tsx`'s own
              // `awaiting` case — the one state where a human waiting is the
              // entire reason the graph stopped moving, so it must not queue
              // behind other polite announcements.
              aria-live={isAwaiting ? 'assertive' : 'polite'}
              className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${meta.tone} ${
                isAwaiting
                  ? 'border-warn bg-warn/15 font-semibold ring-2 ring-warn ring-offset-1 ring-offset-bg'
                  : state.status === 'error'
                    ? 'border-danger bg-danger/10'
                    : 'border-border bg-surface'
              }`}
            >
              <Icon size={12} strokeWidth={2} className={`shrink-0 ${meta.iconClassName}`} aria-hidden="true" />
              {statusLabel(state)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
