import type { AgentProvider } from '@syncode/protocol/events';
import { detectCycle, topologicalLayers } from './graph.js';
import type { Edge, Graph, Node } from './graph.js';
import { uniqueName } from './presets.js';

/**
 * Pure graph editing, view math and wire shaping for the agents builder. No
 * DOM, no React: jsdom has no layout, so everything about a drag that CAN be
 * data is data, and is tested as such.
 */

/** Card geometry. Data, not a CSS measurement — see `NodeCard.tsx`. */
export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 84;
export const PORT_RADIUS = 7;
export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 2;

export interface Point {
  x: number;
  y: number;
}

export interface View {
  pan: Point;
  zoom: number;
}

// ---------------------------------------------------------------- nodes ---

function finite(n: number, fallback: number): number {
  return Number.isFinite(n) ? n : fallback;
}

export function newNodeId(taken: readonly string[], random: () => number = Math.random): string {
  const used = new Set(taken);
  const make = (): string => `n_${Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const id = make();
    if (!used.has(id)) return id;
  }
  // A degenerate RNG must not hang the editor: fall back to a counter.
  for (let n = used.size; ; n += 1) {
    const id = `n_${n.toString(36).padStart(6, '0')}`;
    if (!used.has(id)) return id;
  }
}

/** Below the lowest node, else (80,80). Never exactly on top of an existing node. */
export function autoPlace(graph: Graph): Point {
  if (graph.nodes.length === 0) return { x: 80, y: 80 };
  const lowest = graph.nodes.reduce((a, b) => (b.y > a.y ? b : a));
  return avoidStacking(graph, { x: lowest.x, y: lowest.y + NODE_HEIGHT + 48 });
}

function avoidStacking(graph: Graph, at: Point): Point {
  const p = { x: finite(at.x, 80), y: finite(at.y, 80) };
  while (graph.nodes.some((n) => n.x === p.x && n.y === p.y)) {
    p.x += 24;
    p.y += 24;
  }
  return p;
}

export interface NewNodeSpec {
  configName: string;
  /** Used as the base of a unique display name. */
  name: string;
  provider?: AgentProvider;
  model?: string | null;
  at?: Point;
}

export function addNode(
  graph: Graph,
  spec: NewNodeSpec,
  random: () => number = Math.random,
): { graph: Graph; node: Node } {
  const node: Node = {
    id: newNodeId(
      graph.nodes.map((n) => n.id),
      random,
    ),
    configName: spec.configName,
    displayName: uniqueName(
      spec.name,
      graph.nodes.map((n) => n.displayName),
    ),
    provider: spec.provider ?? 'anthropic',
    model: spec.model ?? null,
    ...(spec.at === undefined ? autoPlace(graph) : avoidStacking(graph, spec.at)),
  };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, node };
}

/** Clamped: NaN/Infinity serialise to `null` and make `POST /crews` 400. */
export function moveNode(graph: Graph, id: string, x: number, y: number): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === id ? { ...n, x: finite(x, n.x), y: finite(y, n.y) } : n)),
  };
}

export function updateNode(graph: Graph, id: string, patch: Partial<Omit<Node, 'id'>>): Graph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) };
}

export function removeNode(graph: Graph, id: string): Graph {
  return {
    nodes: graph.nodes.filter((n) => n.id !== id),
    edges: graph.edges.filter((e) => e.from !== id && e.to !== id),
  };
}

// ---------------------------------------------------------------- edges ---

export type EdgeResult = { ok: true; graph: Graph } | { ok: false; reason: string };

function nameOf(graph: Graph, id: string): string {
  return graph.nodes.find((n) => n.id === id)?.displayName ?? id;
}

/** `from` runs before `to`. Refusals are human sentences naming display names. */
export function addEdge(graph: Graph, from: string, to: string): EdgeResult {
  const ids = new Set(graph.nodes.map((n) => n.id));
  if (!ids.has(from) || !ids.has(to)) return { ok: false, reason: 'One of those agents no longer exists.' };
  if (from === to) return { ok: false, reason: 'A node cannot run after itself.' };
  if (graph.edges.some((e) => e.from === from && e.to === to)) return { ok: false, reason: 'Already connected.' };
  const candidate: Edge = { from, to };
  const cycle = detectCycle(graph.nodes, [...graph.edges, candidate]);
  if (cycle) {
    const path = [...cycle, cycle[0] as string].map((id) => nameOf(graph, id)).join(' -> ');
    return {
      ok: false,
      reason: `That would make a loop: ${path}, so the workflow could never finish.`,
    };
  }
  return { ok: true, graph: { ...graph, edges: [...graph.edges, candidate] } };
}

export function removeEdge(graph: Graph, from: string, to: string): Graph {
  return { ...graph, edges: graph.edges.filter((e) => !(e.from === from && e.to === to)) };
}

// ----------------------------------------------------------- wire shape ---

/**
 * The body `POST /crews` accepts (`configStore.ts` parseCrew): top-level keys
 * ONLY name/members/graph; members ONLY configName/displayName/provider/model
 * with `model` omitted (never null) when unset; graph nodes carry model as
 * string-or-null and finite x/y.
 */
export function toCrewBody(name: string, graph: Graph) {
  return {
    name: name.trim(),
    members: graph.nodes.map((n) => ({
      configName: n.configName,
      displayName: n.displayName,
      provider: n.provider,
      ...(n.model === null ? {} : { model: n.model }),
    })),
    graph: {
      nodes: graph.nodes.map((n) => ({
        id: n.id,
        configName: n.configName,
        displayName: n.displayName,
        provider: n.provider,
        model: n.model,
        x: finite(n.x, 0),
        y: finite(n.y, 0),
      })),
      edges: graph.edges.map((e) => ({ from: e.from, to: e.to })),
    },
  };
}

/** A deep copy of a saved crew's graph, ready to edit. */
export function fromCrew(crew: { graph?: Graph }): Graph {
  const g = crew.graph;
  if (g === undefined) return { nodes: [], edges: [] };
  return {
    nodes: g.nodes.map((n) => ({
      id: n.id,
      configName: n.configName,
      displayName: n.displayName,
      provider: n.provider,
      model: n.model ?? null,
      x: finite(n.x, 0),
      y: finite(n.y, 0),
    })),
    edges: g.edges.map((e) => ({ from: e.from, to: e.to })),
  };
}

// ------------------------------------------------------------- geometry ---

export function portCenter(node: Pick<Node, 'x' | 'y'>, port: 'in' | 'out'): Point {
  return { x: node.x + NODE_WIDTH / 2, y: port === 'in' ? node.y : node.y + NODE_HEIGHT };
}

/** The nearest node whose INPUT port is within `radius` world units of
 *  `world`, ignoring `excludeId` (the source). Pure geometry: jsdom has no
 *  `elementFromPoint`. */
export function hitInputPort(graph: Graph, world: Point, radius: number, excludeId?: string): string | null {
  let best: { id: string; d: number } | null = null;
  for (const n of graph.nodes) {
    if (n.id === excludeId) continue;
    const c = portCenter(n, 'in');
    const d = Math.hypot(c.x - world.x, c.y - world.y);
    if (d <= radius && (best === null || d < best.d)) best = { id: n.id, d };
  }
  return best === null ? null : best.id;
}

export function screenToWorld(screen: Point, view: View): Point {
  return { x: (screen.x - view.pan.x) / view.zoom, y: (screen.y - view.pan.y) / view.zoom };
}

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** Zoom to `newZoom` keeping the world point under `cursor` (canvas-local px) fixed. */
export function zoomAround(view: View, cursor: Point, newZoom: number): View {
  const zoom = clampZoom(newZoom);
  const world = screenToWorld(cursor, view);
  return { zoom, pan: { x: cursor.x - world.x * zoom, y: cursor.y - world.y * zoom } };
}

/** Centre every node in a viewport, zooming out (never in past 1) to fit. */
export function fitView(nodes: readonly Pick<Node, 'x' | 'y'>[], size: { width: number; height: number }): View {
  if (nodes.length === 0 || size.width <= 0 || size.height <= 0) return { pan: { x: 0, y: 0 }, zoom: 1 };
  const pad = 40;
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + NODE_WIDTH));
  const maxY = Math.max(...nodes.map((n) => n.y + NODE_HEIGHT));
  const w = maxX - minX;
  const h = maxY - minY;
  const zoom = clampZoom(Math.min(1, (size.width - pad * 2) / w, (size.height - pad * 2) / h));
  return {
    zoom,
    pan: { x: (size.width - w * zoom) / 2 - minX * zoom, y: (size.height - h * zoom) / 2 - minY * zoom },
  };
}

/** Rows of topological layers, top to bottom (matches the edge geometry). */
export function autoArrange(graph: Graph): Graph {
  const layers = topologicalLayers(graph);
  const pos = new Map<string, Point>();
  layers.forEach((layer, row) => {
    layer.forEach((id, col) => {
      pos.set(id, { x: 80 + col * (NODE_WIDTH + 48), y: 80 + row * (NODE_HEIGHT + 64) });
    });
  });
  return { ...graph, nodes: graph.nodes.map((n) => ({ ...n, ...(pos.get(n.id) ?? {}) })) };
}

export type LayoutMode = 'wide' | 'medium' | 'narrow';

export function layoutModeFor(width: number): LayoutMode {
  if (width >= 760) return 'wide';
  if (width >= 480) return 'medium';
  return 'narrow';
}
