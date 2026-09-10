import type { Edge, Node } from './graph.js';
import { NODE_HEIGHT, NODE_WIDTH } from './NodeCard.js';

export interface EdgesProps {
  nodes: Node[];
  edges: Edge[];
  selectedNodeId: string | null;
}

/**
 * The dependency lines between node cards, one SVG layer positioned under the
 * cards. `pointer-events-none` on the whole layer: a line must never steal a
 * card's click or drag.
 *
 * Endpoints come from `node.x`/`node.y` plus the fixed card geometry in
 * `NodeCard.tsx` — never from `getBoundingClientRect`. jsdom lays nothing
 * out, so a measured endpoint would be `{0,0}` for every node in every test,
 * making this component untestable by construction; computing from the data
 * model instead means the SAME code path runs in a browser and in a test.
 *
 * A dangling edge (naming a node id absent from `nodes`) is `validate`'s job
 * to report (`graph.ts`'s `validate`, surfaced by `Canvas.tsx`'s problems
 * banner) — not this component's job to render. Asking for a missing
 * endpoint here just draws no line for that edge; a mid-edit graph must
 * never crash the surface under it.
 */
export function Edges({ nodes, edges, selectedNodeId }: EdgesProps): JSX.Element {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  return (
    <svg aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-full w-full overflow-visible">
      <defs>
        <marker id="canvas-edge-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="rgb(var(--border-strong))" />
        </marker>
      </defs>
      {edges.map((edge) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (!from || !to) return null;
        const highlighted = edge.from === selectedNodeId || edge.to === selectedNodeId;
        // Bottom-center of "from" to top-center of "to" — the two nodes read
        // as a vertical chain, matching `topologicalLayers`' top-to-bottom
        // auto-layout in `graph.ts`.
        const x1 = from.x + NODE_WIDTH / 2;
        const y1 = from.y + NODE_HEIGHT;
        const x2 = to.x + NODE_WIDTH / 2;
        const y2 = to.y;
        return (
          <line
            key={`${edge.from}->${edge.to}`}
            data-testid={`edge-${edge.from}-${edge.to}`}
            data-edge-from={edge.from}
            data-edge-to={edge.to}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={highlighted ? 'rgb(var(--accent))' : 'rgb(var(--border-strong))'}
            strokeWidth={highlighted ? 2 : 1.5}
            markerEnd="url(#canvas-edge-arrow)"
          />
        );
      })}
    </svg>
  );
}
