import type { Edge, Node } from './graph.js';
import { portCenter } from './graphOps.js';

export interface EdgesProps {
  nodes: Node[];
  edges: Edge[];
  selectedNodeId: string | null;
  /** The selected connection, if any. */
  selectedEdge?: { from: string; to: string } | null;
  /** Click on a connection's (wide, transparent) hit area. Omitted = read-only. */
  onSelectEdge?: (from: string, to: string) => void;
  /** A connection being dragged out of `from`'s output port, in WORLD coordinates. */
  ghost?: { from: string; to: { x: number; y: number }; refused: boolean } | null;
}

/**
 * The dependency lines between node cards, one SVG layer positioned under the
 * cards. The layer itself is `pointer-events-none`: a line must never steal a
 * card's click or drag. Only each connection's wide transparent hit PATH opts
 * back in (`pointer-events: stroke`), so a 1.5px line is still easy to click.
 *
 * Exactly ONE `<line>` per edge carries `data-edge-from` / `data-edge-to`;
 * the hit area and the ghost are `<path>`s, so existing consumers that count
 * lines (or query those attributes) still see one element per connection.
 *
 * Endpoints come from `node.x`/`node.y` plus the fixed card geometry in
 * `graphOps.ts` - never from `getBoundingClientRect`. jsdom lays nothing out,
 * so a measured endpoint would be `{0,0}` for every node in every test; the
 * data model gives the SAME code path in a browser and in a test.
 *
 * A dangling edge (naming a node id absent from `nodes`) is `validate`'s job
 * to report (the Canvas problems banner), not this component's job to render.
 */
export function Edges({ nodes, edges, selectedNodeId, selectedEdge, onSelectEdge, ghost }: EdgesProps): JSX.Element {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ghostFrom = ghost === null || ghost === undefined ? undefined : byId.get(ghost.from);

  return (
    // An explicit 1x1, never h-full/w-full: the pan/zoom layer this sits in has
    // only absolutely positioned children, so it is 0x0, and an <svg> with a
    // zero width or height is not rendered at all (SVG spec) — overflow:visible
    // does not override that. A 1x1 box with overflow:visible paints every
    // edge, at any coordinate, including negative ones after a pan.
    <svg
      aria-hidden="true"
      width={1}
      height={1}
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
    >
      <defs>
        <marker id="canvas-edge-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="rgb(var(--border-strong))" />
        </marker>
        <marker id="canvas-edge-arrow-selected" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="rgb(var(--accent))" />
        </marker>
      </defs>
      {edges.map((edge) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (!from || !to) return null;
        const isSelected = selectedEdge?.from === edge.from && selectedEdge?.to === edge.to;
        const highlighted = isSelected || edge.from === selectedNodeId || edge.to === selectedNodeId;
        // Bottom-centre of "from" to top-centre of "to": the nodes read as a
        // vertical chain, matching `topologicalLayers`' top-to-bottom layout.
        const a = portCenter(from, 'out');
        const b = portCenter(to, 'in');
        return (
          <g key={`${edge.from}->${edge.to}`}>
            <line
              data-testid={`edge-${edge.from}-${edge.to}`}
              data-edge-from={edge.from}
              data-edge-to={edge.to}
              data-selected={isSelected ? 'true' : undefined}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={highlighted ? 'rgb(var(--accent))' : 'rgb(var(--border-strong))'}
              strokeWidth={isSelected ? 3 : highlighted ? 2 : 1.5}
              markerEnd={highlighted ? 'url(#canvas-edge-arrow-selected)' : 'url(#canvas-edge-arrow)'}
            />
            {onSelectEdge !== undefined && (
              <path
                data-edge-hit={`${edge.from}->${edge.to}`}
                d={`M${a.x},${a.y} L${b.x},${b.y}`}
                fill="none"
                stroke="transparent"
                strokeWidth={14}
                style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectEdge(edge.from, edge.to);
                }}
              />
            )}
          </g>
        );
      })}
      {ghost !== null && ghost !== undefined && ghostFrom !== undefined && (
        <path
          data-ghost-edge=""
          d={`M${portCenter(ghostFrom, 'out').x},${portCenter(ghostFrom, 'out').y} L${ghost.to.x},${ghost.to.y}`}
          fill="none"
          stroke={ghost.refused ? 'rgb(var(--danger))' : 'rgb(var(--accent))'}
          strokeWidth={2}
          strokeDasharray="5 4"
        />
      )}
    </svg>
  );
}
