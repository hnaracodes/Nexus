import { describe, expect, it } from 'vitest';
import { parseAgentConfig } from '../../src/server/agentConfig.js';
import { parseCrew } from '../../src/server/configStore.js';
import { addEdge, addNode, toCrewBody } from '../../../web/src/canvas/graphOps.js';
import { PRESETS, presetConfigBody } from '../../../web/src/canvas/presets.js';

/**
 * The agents builder (apps/web/src/canvas) builds request bodies by hand. A
 * field it invents would only be refused in production, so run what it
 * produces through the SERVER's real validators. Pure modules only: no DOM.
 */
describe('web builder request bodies satisfy the server validators', () => {
  it('every preset config is accepted by parseAgentConfig', () => {
    for (const preset of PRESETS) {
      const result = parseAgentConfig(presetConfigBody(preset));
      expect(result.ok, preset.name).toBe(true);
    }
  });

  it('a crew built with the graph ops is accepted by parseCrew, with and without a model', () => {
    let graph = { nodes: [], edges: [] } as Parameters<typeof toCrewBody>[1];
    graph = addNode(graph, { configName: 'Planner', name: 'Planner' }).graph;
    graph = addNode(graph, { configName: 'Coder', name: 'Coder', model: 'some-model', provider: 'openai' }).graph;
    const [a, b] = graph.nodes;
    const edged = addEdge(graph, a!.id, b!.id);
    expect(edged.ok).toBe(true);
    if (!edged.ok) return;

    const body = toCrewBody('  My flow  ', edged.graph);
    expect(body.name).toBe('My flow');
    const result = parseCrew(JSON.parse(JSON.stringify(body)));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    // model: null survives on the graph node, and is omitted on the member.
    expect(result.crew.graph?.nodes[0]?.model).toBeNull();
    expect(result.crew.graph?.nodes[1]?.model).toBe('some-model');
    expect(result.crew.members[0]).not.toHaveProperty('model');
    expect(result.crew.members[1]?.model).toBe('some-model');
  });
});
