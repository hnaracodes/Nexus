import { useCallback, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Graph } from './graph.js';
import { validate } from './graph.js';
import { Edges } from './Edges.js';
import { NodeCard } from './NodeCard.js';

export interface CanvasProps {
  graph: Graph;
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
  /** Persists a drag's final (or in-flight) position. Omitted by a
   *  read-only consumer of this surface, which then simply never moves. */
  onNodeMove?: (nodeId: string, x: number, y: number) => void;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2;

/** Screen-pixel deltas are taken BEFORE dividing by zoom, never after — a
 *  node dragged while zoomed out must still track the pointer 1:1 on
 *  screen, so mixing pre- and post-zoom coordinates mid-drag would make the
 *  card visibly lag or overshoot the cursor. */
interface DragState {
  nodeId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startNodeX: number;
  startNodeY: number;
}

interface PanState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPanX: number;
  startPanY: number;
}

/**
 * The workflow editor's canvas: pan, zoom and node-drag, all hand-rolled over
 * plain pointer events (plan §"Why hand-rolled rather than a graph library"
 * — this repo hand-rolled a ~40-line router rather than take `react-router`,
 * and a node-graph library would bring its own theming and DOM assumptions
 * to replace what is, here, a few hundred lines).
 *
 * This component is a VIEW over `graph.ts`'s model, never a second copy of
 * it — `onSelect`/`onNodeMove` are the only state it raises, nothing is
 * cached here that isn't derivable from `graph` on every render. An invalid
 * graph (a dangling edge, a cycle) is still rendered: `validate()`'s
 * problems surface in a banner rather than the canvas refusing to draw,
 * because a mid-edit graph is routinely invalid — save-time is where a cycle
 * gets refused (plan landmine 2), not render-time.
 *
 * `dragRef`/`panRef` are refs, not state: a pointermove fires far faster than
 * a render needs to settle, and routing every intermediate pixel through
 * `setState` would fight React's batching for no visible benefit — only the
 * numbers that actually change what's on screen (`pan`, `zoom`, and the
 * node's `x`/`y` via `onNodeMove`) go through state.
 */
export function Canvas({ graph, selectedNodeId, onSelect, onNodeMove }: CanvasProps): JSX.Element {
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const dragRef = useRef<DragState | null>(null);
  const panRef = useRef<PanState | null>(null);

  const result = validate(graph);

  const handleBackgroundPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return; // a node card owns its own pointerdown
      panRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPanX: pan.x,
        startPanY: pan.y,
      };
      // jsdom has no PointerEvent capture implementation; guard rather than
      // assume every host supports it (this path is exercised by a mouse in
      // a real browser, never by this file's own test suite).
      if (typeof event.currentTarget.setPointerCapture === 'function') {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    },
    [pan],
  );

  const handleNodeDragStart = useCallback(
    (nodeId: string, event: React.PointerEvent<HTMLDivElement>) => {
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) return;
      event.stopPropagation(); // don't also start a pan on the background handler above
      dragRef.current = {
        nodeId,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startNodeX: node.x,
        startNodeY: node.y,
      };
    },
    [graph.nodes],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag && drag.pointerId === event.pointerId) {
        const dx = (event.clientX - drag.startClientX) / zoom;
        const dy = (event.clientY - drag.startClientY) / zoom;
        onNodeMove?.(drag.nodeId, drag.startNodeX + dx, drag.startNodeY + dy);
        return;
      }
      const panState = panRef.current;
      if (panState && panState.pointerId === event.pointerId) {
        setPan({
          x: panState.startPanX + (event.clientX - panState.startClientX),
          y: panState.startPanY + (event.clientY - panState.startClientY),
        });
      }
    },
    [zoom, onNodeMove],
  );

  const endGesture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
  }, []);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setZoom((current) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current - event.deltaY * 0.001)));
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-bg" aria-label="Workflow canvas">
      {!result.ok && (
        <div role="alert" className="absolute inset-x-0 top-0 z-10 border-b border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle size={14} aria-hidden="true" />
            This workflow can&apos;t run yet:
          </p>
          <ul className="ml-5 list-disc">
            {result.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      <div
        className="absolute inset-0 cursor-default"
        onPointerDown={handleBackgroundPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onWheel={handleWheel}
      >
        <div
          className="absolute left-0 top-0"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}
        >
          <Edges nodes={graph.nodes} edges={graph.edges} selectedNodeId={selectedNodeId} />
          {graph.nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              selected={node.id === selectedNodeId}
              onSelect={onSelect}
              onDragStart={handleNodeDragStart}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
