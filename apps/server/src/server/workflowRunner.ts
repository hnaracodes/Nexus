/**
 * Executing a workflow graph as a real fleet (phase 14, unit H2).
 *
 * THE ONE DECISION THAT GOVERNS THIS FILE: the canvas is a VIEW OVER the
 * orchestration model, not a second one (phase-14-canvas.md). A node is an
 * agent built from a saved config; an edge is a dependency. Executing a graph
 * means spawning through `spawnAgent` (`fleet.ts`, phase 12) and prompting
 * through the exact path a human's prompt already takes — commit a
 * `user_prompt`, then `handle.submit()` (mirrors `index.ts`'s
 * `frame.kind === 'prompt'` branch byte-for-byte) — so attribution and
 * turn-batching (I2') are unchanged. There is no second way to spawn or
 * govern an agent in this file. If executing a graph needed one, the
 * orchestration model underneath it would not be finished.
 *
 * A GRAPH IS NOT A WAY TO PRE-APPROVE. Every node's agent is spawned through
 * `spawnAgent` exactly as a hand-spawned one would be, so it gets the same
 * `agent_spawned`, the same `attachAgent` (I1), the same per-agent
 * `PermissionGate`, and the same room-shared `ApprovalQueue` (phase 12,
 * D1/D3) as any other agent in the room. This file never resolves, times out,
 * or shortens an approval on a node's behalf — it only decides WHEN to spawn
 * one and WHAT prompt to hand it once spawned.
 *
 * DECIDED, not guessed: a node whose agent errors, or whose spawn is refused
 * (most commonly the phase-12 resource cap), FAILS ITS BRANCH. The instant
 * that is observed, every node reachable from it over the edge graph is
 * marked 'skipped' rather than left 'pending' forever — see `skipDescendants`
 * below. Siblings that do not depend on the failed node are unaffected. The
 * alternative — running downstream anyway with the error as context — is
 * defensible too; this file does not do that, because a workflow's whole
 * point is a pipeline of TRUSTED intermediate results, and silently handing a
 * node the text of a crash as if it were a normal instruction risks
 * laundering the failure into something that reads as intentional. 'skipped'
 * exists specifically so a graph with one failed node still SETTLES instead
 * of hanging — see `settled` below.
 *
 * PULL, NOT PUSH. `AgentRuntime` (runtime/types.ts) has no "went idle" event
 * to subscribe to — like `fleetSnapshot` (fleet.ts), the only durable source
 * of "what happened" is the log itself (I3). So a run does not drive itself:
 * the caller must call `run.poll()` whenever the room's log may have moved
 * for one of this run's agents (the natural place is wherever a room already
 * reacts to agent activity, e.g. beside `broadcastFleet()` in `index.ts`).
 * `startWorkflowRun` still spawns every ready node once, synchronously,
 * before returning — the graph's root set needs no event to become ready.
 */
import type { AgentId, AgentProvider, SynCodeEvent, UnsequencedEvent } from '@syncode/protocol/events';
import { agentIdOf } from '@syncode/protocol/events';
import type { Interrupter } from './agent.js';
import type { FleetRuntime } from './fleet.js';
import { spawnAgent } from './fleet.js';
import type { RuntimeDeps } from './runtime/factory.js';

/** A node's saved-config identity plus the provider metadata `spawnAgent`
 *  needs — deliberately NOT `apps/web/src/canvas/graph.ts`'s node shape
 *  imported directly: that package belongs to `@syncode/web`, this one to
 *  `@syncode/server`, and `x`/`y` (canvas position) have no execution meaning.
 *  A structural echo of the same fields, kept independently, the same way
 *  `FleetRuntime` echoes `RoomRuntime` rather than importing it. */
export interface WorkflowNode {
  id: string;
  configName: string;
  displayName: string;
  provider: AgentProvider;
  model: string | null;
}

/** `from` must go idle before `to` may spawn. */
export interface WorkflowEdge {
  from: string;
  to: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export type NodeStatus = 'pending' | 'running' | 'done' | 'errored' | 'skipped';

/**
 * `FleetRuntime` (fleet.ts) plus the one extra member this file needs of its
 * own: `commit`, for `user_prompt` itself, which is NOT agent-scoped
 * (`UserPrompt` in events.ts carries no `agentId`) and so is sealed through
 * `commit`, never `commitAs` — the exact split `crews.ts`'s `CrewRuntime`
 * already documents, and `index.ts`'s own prompt handler already relies on:
 * a prompt aimed at agent X is still committed unstamped (`commit`, which
 * routes to the primary agent's stamp-nothing branch) and ROUTED to X only by
 * calling `X.submit(...)` afterward. `spawn_agent`'s wire-level routing hint
 * is the only place an agent id for a prompt ever lives; it is never
 * persisted onto the `user_prompt` event itself.
 */
export interface WorkflowRuntime extends FleetRuntime {
  commit(event: UnsequencedEvent): SynCodeEvent;
}

export interface StartWorkflowRunArgs {
  runtime: WorkflowRuntime;
  graph: WorkflowGraph;
  /**
   * The room's task for this run. Delivered to every node with NO upstream
   * dependency — a root node has nothing else to run on. A node WITH an
   * upstream is prompted from that upstream's own final message instead (see
   * `promptFor` below), never from this text.
   */
  prompt: string;
  /** Who started the run. Always a person — attributed on every node's
   *  `agent_spawned` (via `spawnAgent`) and on every synthetic `user_prompt`
   *  this file commits, exactly as `launchCrew`'s `by` is (crews.ts). */
  by: Interrupter;
  /**
   * Per-node injection seam, mirroring `spawnAgent`'s own `deps` — but keyed
   * by node, not shared. A single shared `deps` object would hand every node
   * in the graph the SAME stub client, which cannot express a graph whose
   * nodes behave differently (which is every graph worth testing).
   */
  deps?: (node: WorkflowNode) => RuntimeDeps;
  /** Test seam threaded straight through to every node's `spawnAgent` call —
   *  see fleet.ts's own `CanSpawnOptions`. The cap must never depend on the
   *  memory of whatever machine happens to run the suite. */
  totalMemBytes?: number;
  /** Test seam threaded through to every node's `spawnAgent` call. Defaults
   *  to a fresh random id per node. */
  nextAgentId?: () => AgentId;
}

export type StartWorkflowRunResult = { ok: true; run: WorkflowRun } | { ok: false; reason: string };

export interface WorkflowRun {
  /** Node id -> the real agent id `spawnAgent` minted for it, filled in as
   *  nodes spawn. Never has an entry for a node that has not spawned yet. */
  readonly nodeAgentIds: ReadonlyMap<string, AgentId>;
  /** `undefined` for an id not in this graph — deliberately not a silent
   *  fallback to 'pending', the same reasoning `FleetRuntime.getAgent` gives
   *  for not falling back to the primary agent. */
  status(nodeId: string): NodeStatus | undefined;
  /** True once every node is done, errored or skipped — nothing left that
   *  could ever spawn. A LIVE read, not a snapshot taken at some past poll:
   *  see the module comment on why this file is pull-based throughout. */
  readonly settled: boolean;
  /** Re-reads the log for any node currently 'running', advances its status,
   *  cascades a failure to its descendants, and spawns whatever just became
   *  ready — all before returning. Call it whenever this run's room may have
   *  moved. A no-op once `settled`. */
  poll(): void;
}

/**
 * Kahn's algorithm: repeatedly remove a node with no unprocessed upstream.
 * Every node removed this way means true; anything left over sits inside (or
 * downstream of) a cycle, so a smaller visited count than the node count IS
 * the cycle, with no need to name which nodes are in it — `startWorkflowRun`
 * refuses the whole graph either way (see its own comment on why "the whole
 * graph" rather than "the cyclic part").
 */
export function hasCycle(graph: WorkflowGraph): boolean {
  const indegree = new Map<string, number>();
  const downstream = new Map<string, string[]>();
  for (const node of graph.nodes) {
    indegree.set(node.id, 0);
    downstream.set(node.id, []);
  }
  for (const edge of graph.edges) {
    // Dangling edges (naming a node not in `graph.nodes`) are rejected by
    // `startWorkflowRun` before this ever runs; skip rather than throw here
    // so this stays a pure predicate over its own input alone.
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    downstream.get(edge.from)?.push(edge.to);
  }

  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    visited += 1;
    for (const next of downstream.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  return visited !== graph.nodes.length;
}

type AgentOutcome =
  | { kind: 'pending' }
  | { kind: 'idle'; text: string }
  | { kind: 'errored'; message: string };

/**
 * The FIRST of `agent_idle` / `agent_error` this agent ever logged, plus
 * whatever `assistant_message` preceded it — deliberately "first", not
 * `fleet.ts`'s `lifecyclePhase` "last write wins". A node's agent is spawned
 * fresh by this file and given exactly one prompt, so its id has no prior
 * history (`spawnAgent`'s own retirement check guarantees that) and its
 * outcome is decided by however its ONE turn concluded. That matters
 * concretely for the OpenAI/Gemini adapters: an erroring turn there still
 * emits a trailing `agent_idle` in the same continuation (the loop `break`s
 * out of its error branches into the shared idle tail), so scanning for
 * "last" would read every errored node as merely idle. Scanning for "first"
 * reports the turn the way it actually ended.
 */
function nodeOutcome(events: SynCodeEvent[], agentId: AgentId): AgentOutcome {
  let lastText = '';
  for (const event of events) {
    if (agentIdOf(event as { agentId?: AgentId }) !== agentId) continue;
    if (event.type === 'assistant_message') {
      lastText = event.text;
      continue;
    }
    if (event.type === 'agent_idle') return { kind: 'idle', text: lastText };
    if (event.type === 'agent_error') return { kind: 'errored', message: event.message };
  }
  return { kind: 'pending' };
}

/**
 * Start a run. Spawns every root node (no incoming edge) synchronously before
 * returning; every other node spawns later, via `run.poll()`, once its
 * upstream set is entirely 'done'.
 *
 * Validated, in order, BEFORE any agent is touched — the same "resolve
 * everything, then act" discipline `launchCrew` (crews.ts) uses, and for the
 * same reason: a graph that spawns three nodes and then discovers the fourth
 * edge was malformed is a worse failure than one that never starts.
 */
export function startWorkflowRun(args: StartWorkflowRunArgs): StartWorkflowRunResult {
  const { runtime, graph, prompt, by } = args;

  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) return { ok: false, reason: `Two nodes share the id "${node.id}".` };
    nodeIds.add(node.id);
  }
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      return {
        ok: false,
        reason: `An edge names a node that isn't in this graph ("${edge.from}" -> "${edge.to}").`,
      };
    }
  }
  // Refuses the WHOLE graph, not just the cyclic branch of it: a partially
  // started run has already spent real agent slots and real API calls on a
  // graph that was never going to finish, and a human discovering that after
  // the fact is a worse outcome than a clean refusal naming the whole thing.
  if (hasCycle(graph)) {
    return {
      ok: false,
      reason: 'This workflow has a cycle, so it could never finish running. Remove the loop and try again.',
    };
  }

  const downstream = new Map<string, string[]>();
  const upstream = new Map<string, string[]>();
  for (const node of graph.nodes) {
    downstream.set(node.id, []);
    upstream.set(node.id, []);
  }
  for (const edge of graph.edges) {
    downstream.get(edge.from)?.push(edge.to);
    upstream.get(edge.to)?.push(edge.from);
  }

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const statuses = new Map<string, NodeStatus>(graph.nodes.map((node) => [node.id, 'pending' as const]));
  const nodeAgentIds = new Map<string, AgentId>();
  const finalText = new Map<string, string>();

  function isSettled(): boolean {
    for (const status of statuses.values()) {
      if (status === 'pending' || status === 'running') return false;
    }
    return true;
  }

  /** Marks `nodeId` and everything reachable from it 'skipped', stopping the
   *  moment it meets a node that already left 'pending' — a node already
   *  'running'/'done' started before this failure was known and finishes on
   *  its own merits; a node already 'skipped' was reached by an earlier
   *  failure and re-walking its own descendants again would be wasted work,
   *  not a correctness issue, but there is no reason to pay it twice. */
  function skipDescendants(nodeId: string): void {
    const queue = [...(downstream.get(nodeId) ?? [])];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (statuses.get(id) !== 'pending') continue;
      statuses.set(id, 'skipped');
      queue.push(...(downstream.get(id) ?? []));
    }
  }

  /** A root gets the run's own prompt. A node with one upstream gets that
   *  upstream's final message verbatim — a literal pipe, matching the plan's
   *  own wording ("feed the upstream agent's final message in AS the
   *  downstream agent's prompt"). A node with several upstreams (a diamond's
   *  join) gets each labelled by source, since an unlabelled concatenation of
   *  two agents' output would read as one voice instead of two. */
  function promptFor(node: WorkflowNode): string {
    const ups = upstream.get(node.id) ?? [];
    if (ups.length === 0) return prompt;
    if (ups.length === 1) {
      const only = ups[0] as string;
      return finalText.get(only) ?? '(that node finished with no message.)';
    }
    return ups
      .map((id) => {
        const name = nodesById.get(id)?.displayName ?? id;
        const text = finalText.get(id) ?? '(that node finished with no message.)';
        return `Input from workflow node "${name}":\n${text}`;
      })
      .join('\n\n');
  }

  function trySpawn(node: WorkflowNode): void {
    const spawned = spawnAgent({
      runtime,
      displayName: node.displayName,
      provider: node.provider,
      model: node.model,
      by,
      configName: node.configName,
      ...(args.deps === undefined ? {} : { deps: args.deps(node) }),
      ...(args.totalMemBytes === undefined ? {} : { totalMemBytes: args.totalMemBytes }),
      ...(args.nextAgentId === undefined ? {} : { nextId: args.nextAgentId }),
    });

    if (!spawned.ok) {
      // A spawn refusal (in practice, almost always the phase-12 resource
      // cap — see fleet.ts's own comment on `spawnAgent`) fails this node's
      // branch exactly like a runtime error would. A node left 'pending'
      // forever because its slot never freed would hang the run precisely
      // the way an unhandled `agent_error` would.
      statuses.set(node.id, 'errored');
      skipDescendants(node.id);
      return;
    }

    nodeAgentIds.set(node.id, spawned.agentId);
    statuses.set(node.id, 'running');

    // THE ORDINARY PROMPT PATH — see the module comment. `commit`, never
    // `commitAs`: `user_prompt` carries no `agentId` field at all (it is not
    // `AgentScoped`), and routing is achieved purely by which handle's
    // `submit` gets called next, exactly as `index.ts`'s `frame.kind ===
    // 'prompt'` branch already does for a human-typed prompt.
    const text = promptFor(node);
    const logged = runtime.commit({
      type: 'user_prompt',
      participantId: by.participantId,
      displayName: by.displayName,
      text,
      // Never true: a workflow's synthetic hand-off is not a human holding
      // the driver token, and marking it so would let a graph's own prompts
      // silently outrank a person's in the I2' precedence rule they were
      // never part of earning.
      wasDriver: false,
    });

    const handle = runtime.getAgent(spawned.agentId);
    // spawnAgent just attached this id through the very `attachAgent` I1
    // enforces everywhere else (fleet.ts calls it internally); a missing
    // handle here would mean attachAgent itself failed to register what it
    // just reported success for, which is a bug in that contract, not a
    // branch this file should paper over by silently dropping the node.
    if (handle === undefined) {
      throw new Error(
        `spawnAgent reported success for "${spawned.agentId}" but no handle is attached for it.`,
      );
    }
    handle.submit({ seq: logged.seq, displayName: by.displayName, text, wasDriver: false });
  }

  function spawnReady(): void {
    for (const node of graph.nodes) {
      if (statuses.get(node.id) !== 'pending') continue;
      const ups = upstream.get(node.id) ?? [];
      if (ups.every((id) => statuses.get(id) === 'done')) trySpawn(node);
    }
  }

  function checkRunning(): void {
    const events = runtime.sink.read();
    for (const node of graph.nodes) {
      if (statuses.get(node.id) !== 'running') continue;
      const agentId = nodeAgentIds.get(node.id);
      if (agentId === undefined) continue; // unreachable: 'running' implies an id was recorded
      const outcome = nodeOutcome(events, agentId);
      if (outcome.kind === 'pending') continue;
      if (outcome.kind === 'idle') {
        statuses.set(node.id, 'done');
        finalText.set(node.id, outcome.text);
        continue;
      }
      statuses.set(node.id, 'errored');
      skipDescendants(node.id);
    }
  }

  spawnReady(); // the root set — ready with no event needed at all

  return {
    ok: true,
    run: {
      nodeAgentIds,
      status: (nodeId: string) => statuses.get(nodeId),
      get settled(): boolean {
        return isSettled();
      },
      poll(): void {
        checkRunning();
        spawnReady();
      },
    },
  };
}
