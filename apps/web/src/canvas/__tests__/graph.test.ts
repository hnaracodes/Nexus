import { describe, expect, it } from 'vitest';
import type { Edge, Graph, Node } from '../graph.js';
import { detectCycle, readyNodes, topologicalLayers, validate } from '../graph.js';

/** A node with sane defaults, overridable per test. x/y and provider/model
 *  are irrelevant to every test below except that the type requires them. */
function node(id: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    configName: `${id}-config`,
    displayName: id,
    provider: 'anthropic',
    model: null,
    x: 0,
    y: 0,
    ...overrides,
  };
}

describe('readyNodes', () => {
  it('releases a 3-node chain one link at a time', () => {
    const graph: Graph = {
      nodes: [node('A'), node('B'), node('C')],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
      ],
    };

    expect(readyNodes(graph, new Set())).toEqual(['A']);
    expect(readyNodes(graph, new Set(['A']))).toEqual(['B']);
    expect(readyNodes(graph, new Set(['A', 'B']))).toEqual(['C']);
    expect(readyNodes(graph, new Set(['A', 'B', 'C']))).toEqual([]);
  });

  it('does not release a diamond join until BOTH branches complete', () => {
    const graph: Graph = {
      nodes: [node('A'), node('B'), node('C'), node('D')],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'C' },
        { from: 'B', to: 'D' },
        { from: 'C', to: 'D' },
      ],
    };

    expect(readyNodes(graph, new Set())).toEqual(['A']);
    expect(readyNodes(graph, new Set(['A']))).toEqual(['B', 'C']);
    // Only one branch done — D must NOT appear yet, in either order.
    expect(readyNodes(graph, new Set(['A', 'B']))).toEqual(['C']);
    expect(readyNodes(graph, new Set(['A', 'C']))).toEqual(['B']);
    // Both branches done — now D is ready.
    expect(readyNodes(graph, new Set(['A', 'B', 'C']))).toEqual(['D']);
    expect(readyNodes(graph, new Set(['A', 'B', 'C', 'D']))).toEqual([]);
  });

  it('treats a disconnected node as immediately ready — no upstream means nothing to wait for', () => {
    const graph: Graph = {
      nodes: [node('A'), node('B'), node('Lonely')],
      edges: [{ from: 'A', to: 'B' }],
    };

    expect(readyNodes(graph, new Set())).toEqual(['A', 'Lonely']);
  });
});

describe('topologicalLayers', () => {
  it('lays out a 3-node chain as one node per layer', () => {
    const graph: Graph = {
      nodes: [node('A'), node('B'), node('C')],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
      ],
    };

    expect(topologicalLayers(graph)).toEqual([['A'], ['B'], ['C']]);
  });

  it('lays out a diamond with the join in its own final layer', () => {
    const graph: Graph = {
      nodes: [node('A'), node('B'), node('C'), node('D')],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'C' },
        { from: 'B', to: 'D' },
        { from: 'C', to: 'D' },
      ],
    };

    expect(topologicalLayers(graph)).toEqual([['A'], ['B', 'C'], ['D']]);
  });

  it('places a disconnected node in the first layer alongside other roots', () => {
    const graph: Graph = {
      nodes: [node('A'), node('B'), node('Lonely')],
      edges: [{ from: 'A', to: 'B' }],
    };

    expect(topologicalLayers(graph)).toEqual([['A', 'Lonely'], ['B']]);
  });
});

describe('detectCycle', () => {
  it('returns null for an acyclic graph', () => {
    const nodes = [node('A'), node('B'), node('C')];
    const edges: Edge[] = [
      { from: 'A', to: 'B' },
      { from: 'A', to: 'C' },
    ];

    expect(detectCycle(nodes, edges)).toBeNull();
  });

  it('detects a 2-cycle and names both nodes', () => {
    const nodes = [node('A'), node('B')];
    const edges: Edge[] = [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'A' },
    ];

    expect(detectCycle(nodes, edges)).toEqual(['A', 'B']);
  });

  it('detects a 3-cycle and names all three nodes', () => {
    const nodes = [node('A'), node('B'), node('C')];
    const edges: Edge[] = [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
      { from: 'C', to: 'A' },
    ];

    expect(detectCycle(nodes, edges)).toEqual(['A', 'B', 'C']);
  });

  it('treats a self-edge as a cycle', () => {
    const nodes = [node('A')];
    const edges: Edge[] = [{ from: 'A', to: 'A' }];

    expect(detectCycle(nodes, edges)).toEqual(['A']);
  });

  it('does not false-positive on a diamond, where D is reachable via two paths', () => {
    const nodes = [node('A'), node('B'), node('C'), node('D')];
    const edges: Edge[] = [
      { from: 'A', to: 'B' },
      { from: 'A', to: 'C' },
      { from: 'B', to: 'D' },
      { from: 'C', to: 'D' },
    ];

    expect(detectCycle(nodes, edges)).toBeNull();
  });
});

describe('validate', () => {
  it('accepts a valid acyclic graph', () => {
    const graph: Graph = {
      nodes: [node('A'), node('B')],
      edges: [{ from: 'A', to: 'B' }],
    };

    expect(validate(graph)).toEqual({ ok: true });
  });

  it('accepts a disconnected node as valid — it just runs immediately, it is not dropped', () => {
    const graph: Graph = {
      nodes: [node('A'), node('B'), node('Lonely')],
      edges: [{ from: 'A', to: 'B' }],
    };

    expect(validate(graph)).toEqual({ ok: true });
  });

  it('rejects an edge naming a node that does not exist, naming it in the problem', () => {
    const graph: Graph = {
      nodes: [node('A')],
      edges: [{ from: 'A', to: 'ghost' }],
    };

    const result = validate(graph);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation to fail');
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('ghost');
  });

  it('rejects an edge whose SOURCE does not exist, naming it in the problem', () => {
    const graph: Graph = {
      nodes: [node('B')],
      edges: [{ from: 'ghost', to: 'B' }],
    };

    const result = validate(graph);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation to fail');
    expect(result.problems[0]).toContain('ghost');
  });

  it('rejects a cycle at save time, naming every node in it', () => {
    const graph: Graph = {
      nodes: [node('A'), node('B')],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'A' },
      ],
    };

    const result = validate(graph);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation to fail');
    expect(result.problems.some((p) => p.includes('A') && p.includes('B'))).toBe(true);
  });

  it('rejects a self-edge as a cycle, naming the node', () => {
    const graph: Graph = {
      nodes: [node('A')],
      edges: [{ from: 'A', to: 'A' }],
    };

    const result = validate(graph);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation to fail');
    expect(result.problems[0]).toContain('A');
  });
});
