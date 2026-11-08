import { describe, expect, it } from 'vitest';
import type { Graph, Node } from '../graph.js';
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  addEdge,
  addNode,
  autoArrange,
  autoPlace,
  fitView,
  fromCrew,
  hitInputPort,
  layoutModeFor,
  moveNode,
  portCenter,
  removeEdge,
  removeNode,
  screenToWorld,
  toCrewBody,
  zoomAround,
} from '../graphOps.js';

function n(id: string, over: Partial<Node> = {}): Node {
  return { id, configName: `${id}-cfg`, displayName: id.toUpperCase(), provider: 'anthropic', model: null, x: 0, y: 0, ...over };
}
const g = (nodes: Node[], edges: Graph['edges'] = []): Graph => ({ nodes, edges });

describe('addNode', () => {
  it('mints unique ids even when the RNG repeats', () => {
    let graph = g([]);
    const rng = () => 0.5;
    for (let i = 0; i < 3; i += 1) graph = addNode(graph, { configName: 'c', name: 'Coder' }, rng).graph;
    expect(new Set(graph.nodes.map((x) => x.id)).size).toBe(3);
  });
  it('mints unique display names', () => {
    let graph = g([]);
    for (let i = 0; i < 3; i += 1) graph = addNode(graph, { configName: 'Coder', name: 'Coder' }).graph;
    expect(graph.nodes.map((x) => x.displayName)).toEqual(['Coder', 'Coder 2', 'Coder 3']);
  });
  it('never stacks exactly on an existing node, even at a requested spot', () => {
    let graph = g([]);
    for (let i = 0; i < 4; i += 1) graph = addNode(graph, { configName: 'c', name: 'A', at: { x: 10, y: 10 } }).graph;
    const keys = graph.nodes.map((x) => `${x.x},${x.y}`);
    expect(new Set(keys).size).toBe(4);
  });
  it('defaults: anthropic, null model, (80,80) first then below the lowest', () => {
    const first = addNode(g([]), { configName: 'c', name: 'A' });
    expect(first.node).toMatchObject({ provider: 'anthropic', model: null, x: 80, y: 80 });
    const second = addNode(first.graph, { configName: 'c', name: 'B' });
    expect(second.node.y).toBeGreaterThan(80 + NODE_HEIGHT);
  });
  it('autoPlace on empty graph is (80,80)', () => {
    expect(autoPlace(g([]))).toEqual({ x: 80, y: 80 });
  });
});

describe('moveNode / removeNode', () => {
  it('moves and clamps non-finite coordinates', () => {
    const moved = moveNode(g([n('a', { x: 5, y: 6 })]), 'a', 20, 30);
    expect(moved.nodes[0]).toMatchObject({ x: 20, y: 30 });
    const bad = moveNode(moved, 'a', NaN, Infinity);
    expect(bad.nodes[0]).toMatchObject({ x: 20, y: 30 });
  });
  it('removeNode drops incident edges only', () => {
    const graph = g([n('a'), n('b'), n('c')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }]);
    const out = removeNode(graph, 'b');
    expect(out.nodes.map((x) => x.id)).toEqual(['a', 'c']);
    expect(out.edges).toEqual([{ from: 'a', to: 'c' }]);
  });
});

describe('addEdge', () => {
  const base = g([n('a'), n('b'), n('c')], [{ from: 'a', to: 'b' }]);
  it('adds a legal edge', () => {
    const r = addEdge(base, 'b', 'c');
    expect(r.ok && r.graph.edges).toHaveLength(2);
  });
  it('refuses self, duplicate and unknown', () => {
    expect(addEdge(base, 'a', 'a')).toEqual({ ok: false, reason: 'A node cannot run after itself.' });
    expect(addEdge(base, 'a', 'b')).toEqual({ ok: false, reason: 'Already connected.' });
    expect(addEdge(base, 'a', 'zzz').ok).toBe(false);
    expect(addEdge(base, 'zzz', 'a').ok).toBe(false);
  });
  it('refuses a 2-cycle naming display names', () => {
    const r = addEdge(base, 'b', 'a');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('loop');
      expect(r.reason).toMatch(/A -> B -> A|B -> A -> B/);
      expect(r.reason).not.toContain('"a"');
    }
  });
  it('refuses a 3-cycle', () => {
    const chain = g([n('a'), n('b'), n('c')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
    const r = addEdge(chain, 'c', 'a');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/A|B|C/);
  });
  it('allows a diamond and a disconnected node', () => {
    let graph = g([n('a'), n('b'), n('c'), n('d'), n('e')]);
    for (const [f, t] of [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']] as const) {
      const r = addEdge(graph, f, t);
      expect(r.ok).toBe(true);
      if (r.ok) graph = r.graph;
    }
    expect(graph.edges).toHaveLength(4);
  });
  it('removeEdge removes only that edge', () => {
    const out = removeEdge(g([n('a'), n('b')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]), 'a', 'b');
    expect(out.edges).toEqual([{ from: 'b', to: 'a' }]);
  });
});

describe('toCrewBody / fromCrew', () => {
  // Shape source: apps/server/src/server/configStore.ts parseCrew (top-level
  // keys name/members/graph; member keys configName/displayName/provider/model?).
  const graph = g(
    [n('a', { model: 'm1', x: 1, y: 2 }), n('b', { x: 3, y: 4 })],
    [{ from: 'a', to: 'b' }],
  );
  it('has exactly the accepted top-level and member keys', () => {
    const body = toCrewBody('  Flow ', graph);
    expect(Object.keys(body).sort()).toEqual(['graph', 'members', 'name']);
    expect(body.name).toBe('Flow');
    for (const m of body.members) {
      expect(Object.keys(m).every((k) => ['configName', 'displayName', 'provider', 'model'].includes(k))).toBe(true);
    }
  });
  it('omits member.model when null but keeps it when set; graph model is string|null', () => {
    const body = toCrewBody('f', graph);
    expect(body.members[0]).toHaveProperty('model', 'm1');
    expect(body.members[1]).not.toHaveProperty('model');
    expect(body.graph.nodes.map((x) => x.model)).toEqual(['m1', null]);
  });
  it('x/y are always finite', () => {
    const body = toCrewBody('f', g([n('a', { x: NaN, y: Infinity })]));
    expect(Number.isFinite(body.graph.nodes[0]!.x)).toBe(true);
    expect(Number.isFinite(body.graph.nodes[0]!.y)).toBe(true);
  });
  it('round-trips through fromCrew as a deep copy', () => {
    const back = fromCrew({ graph: toCrewBody('f', graph).graph as Graph });
    expect(back).toEqual(graph);
    expect(back.nodes[0]).not.toBe(graph.nodes[0]);
  });
  it('fromCrew of a crew with no graph is empty', () => {
    expect(fromCrew({})).toEqual({ nodes: [], edges: [] });
  });
});

describe('ports', () => {
  const graph = g([n('a', { x: 0, y: 0 }), n('b', { x: 0, y: 200 }), n('c', { x: 10, y: 200 })]);
  it('portCenter is top-centre for in and bottom-centre for out', () => {
    expect(portCenter(graph.nodes[0]!, 'in')).toEqual({ x: NODE_WIDTH / 2, y: 0 });
    expect(portCenter(graph.nodes[0]!, 'out')).toEqual({ x: NODE_WIDTH / 2, y: NODE_HEIGHT });
  });
  it('hits inside the radius, misses outside', () => {
    expect(hitInputPort(graph, { x: NODE_WIDTH / 2, y: 205 }, 16)).toBe('b');
    expect(hitInputPort(graph, { x: NODE_WIDTH / 2, y: 260 }, 16)).toBeNull();
  });
  it('picks the nearest of two and ignores the source', () => {
    expect(hitInputPort(graph, { x: NODE_WIDTH / 2 + 8, y: 200 }, 30)).toBe('c');
    expect(hitInputPort(graph, { x: NODE_WIDTH / 2, y: 0 }, 16, 'a')).toBeNull();
  });
});

describe('view math', () => {
  it('screenToWorld inverts pan and zoom', () => {
    expect(screenToWorld({ x: 120, y: 70 }, { pan: { x: 20, y: 10 }, zoom: 2 })).toEqual({ x: 50, y: 30 });
  });
  it('zoomAround keeps the cursor point fixed', () => {
    const view = { pan: { x: 30, y: -20 }, zoom: 1 };
    const cursor = { x: 200, y: 150 };
    const before = screenToWorld(cursor, view);
    const next = zoomAround(view, cursor, 1.5);
    const after = screenToWorld(cursor, next);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
  it('zoomAround clamps to 0.4..2', () => {
    expect(zoomAround({ pan: { x: 0, y: 0 }, zoom: 1 }, { x: 0, y: 0 }, 99).zoom).toBe(2);
    expect(zoomAround({ pan: { x: 0, y: 0 }, zoom: 1 }, { x: 0, y: 0 }, 0.01).zoom).toBe(0.4);
  });
  it('fitView: empty, one, many', () => {
    expect(fitView([], { width: 800, height: 600 })).toEqual({ pan: { x: 0, y: 0 }, zoom: 1 });
    const one = fitView([{ x: 0, y: 0 }], { width: 800, height: 600 });
    expect(one.zoom).toBe(1);
    expect(one.pan.x).toBeCloseTo((800 - NODE_WIDTH) / 2);
    const many = fitView([{ x: 0, y: 0 }, { x: 3000, y: 2000 }], { width: 800, height: 600 });
    expect(many.zoom).toBeLessThan(1);
    expect(many.zoom).toBeGreaterThanOrEqual(0.4);
  });
});

describe('autoArrange / layoutModeFor', () => {
  it('puts downstream nodes in lower rows', () => {
    const out = autoArrange(g([n('a'), n('b')], [{ from: 'a', to: 'b' }]));
    expect(out.nodes[1]!.y).toBeGreaterThan(out.nodes[0]!.y);
  });
  it('layout mode boundaries', () => {
    expect(layoutModeFor(479)).toBe('narrow');
    expect(layoutModeFor(480)).toBe('medium');
    expect(layoutModeFor(759)).toBe('medium');
    expect(layoutModeFor(760)).toBe('wide');
  });
});
