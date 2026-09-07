import type { AgentProvider } from '@nexus/protocol/events';

/**
 * The workflow graph model (phase 14, plan §"Shape"). Pure, no DOM, no React —
 * this is where the canvas's correctness lives, and where tests are cheap:
 * jsdom has no layout, so drag/zoom/hit-testing can't be asserted there at
 * all, but a cycle, a ready set or a topological layer is just data.
 *
 * A node is an agent built from a saved config (phase 13); an edge is a
 * dependency, "to" starts once "from" has finished. This module never spawns
 * or governs anything — that is `apps/server/src/server/workflowRunner.ts`'s
 * job, over the SAME fleet/approval gate every hand-spawned agent goes
 * through (plan: "a graph is not a way to pre-approve"). This file only
 * answers three questions a runner or an editor needs: is this graph legal,
 * what can start now, and how should it be laid out.
 */

export interface Node {
  id: string;
  /** The saved agent config (phase 13) this node instantiates. */
  configName: string;
  displayName: string;
  provider: AgentProvider;
  /** `null` means "use the config's default" — same convention as
   *  `AgentDescriptor.model` in `derive/fleet.ts`. */
  model: string | null;
  x: number;
  y: number;
}

/** "to" starts once "from" has finished. Both are node ids — an edge is data,
 *  not a reference, so it can legally name a node that does not exist; that
 *  is precisely what `validate` must catch (plan: "an edge naming a node
 *  that does not exist is invalid, not ignored"). */
export interface Edge {
  from: string;
  to: string;
}

export interface Graph {
  nodes: Node[];
  edges: Edge[];
}

export type ValidationResult = { ok: true } | { ok: false; problems: string[] };

/**
 * DFS cycle detection with the standard three-color scheme (unvisited /
 * on-the-current-path / fully-explored), over the vertex set of `nodes` PLUS
 * any id that only appears as an edge endpoint — a dangling edge is still
 * capable of forming a cycle back to a real node (e.g. a self-edge on a real
 * node), and `validate` calls this independently of its own missing-node
 * check, so this must not assume every edge endpoint is a known node.
 *
 * Takes `(nodes, edges)` rather than a `Graph`, per the plan's exact
 * signature — this is the one function callable straight from an in-progress
 * edit before the caller has assembled a full `Graph`.
 *
 * On a hit, the cycle is read directly off the DFS stack: when the walk
 * reaches a node that is currently ON the stack (not merely visited before),
 * everything from that node's position to the top of the stack IS the cycle,
 * in the order it was walked. A diamond's shared descendant (reachable via
 * two paths) is marked fully-explored after its first visit and is never
 * mistaken for "on the current path" on its second, so it does not
 * false-positive as a cycle — see the "does not false-positive on a
 * diamond" test.
 */
export function detectCycle(nodes: Node[], edges: Edge[]): string[] | null {
  const adjacency = new Map<string, string[]>();
  const vertices: string[] = [];
  const known = new Set<string>();

  const addVertex = (id: string): void => {
    if (!known.has(id)) {
      known.add(id);
      vertices.push(id);
    }
  };
  for (const node of nodes) addVertex(node.id);
  for (const edge of edges) {
    addVertex(edge.from);
    addVertex(edge.to);
    const outgoing = adjacency.get(edge.from);
    if (outgoing) outgoing.push(edge.to);
    else adjacency.set(edge.from, [edge.to]);
  }

  const UNVISITED = 0;
  const ON_STACK = 1;
  const DONE = 2;
  const state = new Map<string, number>(vertices.map((id) => [id, UNVISITED]));
  const stack: string[] = [];

  function visit(id: string): string[] | null {
    state.set(id, ON_STACK);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const nextState = state.get(next);
      if (nextState === ON_STACK) {
        const start = stack.indexOf(next);
        return stack.slice(start);
      }
      if (nextState === UNVISITED) {
        const found = visit(next);
        if (found) return found;
      }
      // DONE: already fully explored with no cycle found through it — a
      // second arrival here (the diamond case) is not a repeat visit to the
      // current path, so it is not a cycle.
    }
    stack.pop();
    state.set(id, DONE);
    return null;
  }

  for (const id of vertices) {
    if (state.get(id) === UNVISITED) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Every node whose upstream set is a subset of `completed`, excluding nodes
 * already completed themselves (a finished node is not "ready to start"
 * again). A node with NO upstream edges is ready from the start — the
 * `.every()` over an empty array is vacuously true — which is the documented
 * behaviour for a disconnected node: it runs immediately rather than being
 * silently dropped (plan: "decide and document").
 *
 * Order follows `graph.nodes`, so callers get a stable, deterministic list
 * rather than Set/Map iteration order.
 */
export function readyNodes(graph: Graph, completed: Set<string>): string[] {
  const upstreamOf = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const upstream = upstreamOf.get(edge.to);
    if (upstream) upstream.push(edge.from);
    else upstreamOf.set(edge.to, [edge.from]);
  }

  const ready: string[] = [];
  for (const node of graph.nodes) {
    if (completed.has(node.id)) continue;
    const upstream = upstreamOf.get(node.id) ?? [];
    if (upstream.every((id) => completed.has(id))) ready.push(node.id);
  }
  return ready;
}

/**
 * Kahn's-algorithm layering for auto-layout: layer 0 is every node with no
 * upstream dependency, layer N+1 is every not-yet-placed node whose upstream
 * set is fully contained in layers 0..N. A disconnected node has no upstream,
 * so it lands in layer 0 alongside the graph's other roots.
 *
 * Only edges into a KNOWN node are counted as dependencies — a dangling edge
 * (`validate`'s job to reject) must not make a real node wait forever on a
 * phantom upstream that can never complete.
 *
 * Defensive against a cycle reaching this function anyway (it never should —
 * `validate` refuses one at save time, plan landmine 2): if a pass places
 * nothing, whatever remains can only be waiting on itself, so layering stops
 * rather than looping forever. Those nodes are simply omitted, on the
 * assumption the caller already validated and this is unreachable in
 * practice.
 */
export function topologicalLayers(graph: Graph): string[][] {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const upstreamOf = new Map<string, Set<string>>(graph.nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of graph.edges) {
    if (nodeIds.has(edge.to) && nodeIds.has(edge.from)) upstreamOf.get(edge.to)!.add(edge.from);
  }

  const placed = new Set<string>();
  const layers: string[][] = [];
  const ids = graph.nodes.map((node) => node.id);

  while (placed.size < ids.length) {
    const layer = ids.filter((id) => {
      if (placed.has(id)) return false;
      const upstream = upstreamOf.get(id)!;
      return [...upstream].every((u) => placed.has(u));
    });
    if (layer.length === 0) break; // unreachable on a validated graph — see doc comment above
    for (const id of layer) placed.add(id);
    layers.push(layer);
  }

  return layers;
}

/**
 * The save-time gate (plan landmine 2: "a cycle must be refused at save
 * time, not at run time" — discovering an unrunnable workflow only once a
 * user has already drawn it is the failure this exists to prevent).
 *
 * Two independent checks, both reported together rather than short-circuited,
 * so a single save attempt shows every problem instead of one per retry:
 *   - every edge endpoint must name a real node (a dangling edge is invalid,
 *     not silently ignored);
 *   - the graph must be acyclic.
 * A disconnected node is deliberately NOT a problem — see `readyNodes`.
 */
export function validate(graph: Graph): ValidationResult {
  const problems: string[] = [];
  const nodeIds = new Set(graph.nodes.map((node) => node.id));

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from)) {
      problems.push(
        `Edge from "${edge.from}" to "${edge.to}" names a node that does not exist: "${edge.from}".`,
      );
    }
    if (!nodeIds.has(edge.to)) {
      problems.push(
        `Edge from "${edge.from}" to "${edge.to}" names a node that does not exist: "${edge.to}".`,
      );
    }
  }

  const cycle = detectCycle(graph.nodes, graph.edges);
  if (cycle) {
    problems.push(`Workflow has a cycle: ${[...cycle, cycle[0]].join(' -> ')}.`);
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
