import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Canvas } from '../Canvas.js';
import type { Edge, Graph, Node } from '../graph.js';

/** Mirrors `graph.test.ts`'s fixture helper — x/y only matter for edge
 *  geometry, which these tests deliberately don't assert on (jsdom has no
 *  layout, so a pixel-exact endpoint would be testing a coincidence). */
function node(id: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    configName: `${id}-config`,
    displayName: `Agent ${id}`,
    provider: 'anthropic',
    model: null,
    x: 0,
    y: 0,
    ...overrides,
  };
}

function graph(nodes: Node[], edges: Edge[] = []): Graph {
  return { nodes, edges };
}

describe('Canvas', () => {
  it('renders one card per node with its display name, config name and provider', () => {
    const g = graph([
      node('a', { displayName: 'Reviewer', configName: 'apollo-reviewer', provider: 'anthropic' }),
      node('b', { displayName: 'Fixer', configName: 'gpt-fixer', provider: 'openai' }),
    ]);

    render(<Canvas graph={g} selectedNodeId={null} onSelect={vi.fn()} />);

    expect(screen.getByText('Reviewer')).toBeInTheDocument();
    expect(screen.getByText('apollo-reviewer')).toBeInTheDocument();
    expect(screen.getByText(/Anthropic/)).toBeInTheDocument();

    expect(screen.getByText('Fixer')).toBeInTheDocument();
    expect(screen.getByText('gpt-fixer')).toBeInTheDocument();
    expect(screen.getByText(/OpenAI/)).toBeInTheDocument();
  });

  it('renders an edge element per edge, connecting the right two nodes', () => {
    const g = graph(
      [node('a'), node('b'), node('c')],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    );

    const { container } = render(<Canvas graph={g} selectedNodeId={null} onSelect={vi.fn()} />);

    expect(container.querySelectorAll('line')).toHaveLength(2);
    expect(container.querySelector('[data-edge-from="a"][data-edge-to="b"]')).not.toBeNull();
    expect(container.querySelector('[data-edge-from="b"][data-edge-to="c"]')).not.toBeNull();
    // Not the reverse pairing, and not a third phantom edge.
    expect(container.querySelector('[data-edge-from="b"][data-edge-to="a"]')).toBeNull();
  });

  it('clicking a node selects it and calls onSelect with its id', () => {
    const g = graph([node('a', { displayName: 'Reviewer' }), node('b', { displayName: 'Fixer' })]);
    const onSelect = vi.fn();

    render(<Canvas graph={g} selectedNodeId={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Reviewer/ }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('a node is focusable and selectable by keyboard', () => {
    const g = graph([node('a', { displayName: 'Reviewer' })]);
    const onSelect = vi.fn();

    render(<Canvas graph={g} selectedNodeId={null} onSelect={onSelect} />);
    const card = screen.getByRole('button', { name: /Reviewer/ });

    expect(card).toHaveAttribute('tabIndex', '0');
    card.focus();
    expect(card).toHaveFocus();

    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('a');

    fireEvent.keyDown(card, { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("renders an invalid graph's validation problems rather than crashing", () => {
    const g = graph([node('a', { displayName: 'Reviewer' })], [{ from: 'a', to: 'ghost' }]);

    expect(() => render(<Canvas graph={g} selectedNodeId={null} onSelect={vi.fn()} />)).not.toThrow();

    // The valid node still renders — an invalid graph is routinely a
    // mid-edit state, not a reason to blank the whole canvas.
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
    // validate()'s own message, not a paraphrase — coupled on purpose so
    // this fails loudly if graph.ts's wording ever drifts.
    expect(
      screen.getByText('Edge from "a" to "ghost" names a node that does not exist: "ghost".'),
    ).toBeInTheDocument();
    // The dangling edge draws nothing rather than crashing on a missing endpoint.
    expect(document.querySelectorAll('line')).toHaveLength(0);
  });
});
