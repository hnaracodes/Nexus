import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, Maximize2, Network, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import type { Graph } from './graph.js';
import { validate } from './graph.js';
import { Edges } from './Edges.js';
import { NodeCard } from './NodeCard.js';
import type { NodePorts } from './NodeCard.js';
import { clampZoom, fitView, hitInputPort, portCenter, screenToWorld, zoomAround } from './graphOps.js';
import type { Point, View } from './graphOps.js';

/** The MIME type a palette entry sets on a drag, and the canvas accepts. */
export const AGENT_DRAG_TYPE = 'application/x-syncode-agent';

export interface CanvasProps {
  graph: Graph;
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
  /** Persists a drag's in-flight and final position. Omitted by a read-only
   *  consumer of this surface, which then simply never moves. */
  onNodeMove?: (nodeId: string, x: number, y: number) => void;
  selectedEdge?: { from: string; to: string } | null;
  onSelectEdge?: (from: string, to: string) => void;
  /** A click on empty canvas. */
  onClearSelection?: () => void;
  /** Make `to` run after `from`. Returns null on success, else the refusal
   *  sentence (shown to the person as-is). Providing this makes the canvas
   *  editable: ports appear. */
  onConnect?: (from: string, to: string) => string | null;
  /** Live preview of the same decision while hovering a target (no mutation). */
  checkConnect?: (from: string, to: string) => string | null;
  /** Delete/Backspace on the focused canvas, and the toolbar button. */
  onDeleteSelection?: () => void;
  /** A palette entry dropped on the canvas, at a WORLD point. */
  onDropAgent?: (payload: string, world: Point) => void;
  onAutoArrange?: () => void;
  /** Shown centred while the graph has no nodes. */
  emptyState?: ReactNode;
  /** Rendered INSIDE the pan/zoom layer, so it tracks the nodes. */
  children?: ReactNode;
}

const DRAG_THRESHOLD = 3;
const CONNECT_RADIUS = 16;

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
  moved: boolean;
}

interface ConnectState {
  from: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  moved: boolean;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

const TOOL_BUTTON =
  'inline-flex h-8 w-8 items-center justify-center rounded-md border border-border-strong bg-surface-2 text-fg-muted ' +
  'hover:bg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50';

/**
 * The workflow editor's canvas: pan, zoom, node-drag, connect and select, all
 * hand-rolled over plain pointer events (this repo hand-rolled a ~40-line
 * router rather than take `react-router`, and a node-graph library would
 * bring its own theming and DOM assumptions).
 *
 * This component is a VIEW over `graph.ts`'s model, never a second copy of it:
 * everything it raises (`onSelect`, `onNodeMove`, `onConnect`, ...) is a
 * request to the owner of the graph, and nothing is cached here that is not
 * derivable from `graph`. An invalid graph (a dangling edge, a cycle) is still
 * rendered with `validate()`'s problems in a banner - a mid-edit graph is
 * routinely invalid, and save-time is where a cycle is refused.
 *
 * Gestures live in refs, not state: a pointermove fires far faster than a
 * render needs to settle. Only what changes the picture (`view`, the ghost
 * edge, the armed port) goes through state.
 *
 * What only a real browser can cover: actual pointer geometry and
 * `setPointerCapture`, native non-passive wheel/pinch, HTML5 drag-and-drop.
 * The pure maths for all of it is tested in graphOps.test.ts.
 */
export function Canvas({
  graph,
  selectedNodeId,
  onSelect,
  onNodeMove,
  selectedEdge = null,
  onSelectEdge,
  onClearSelection,
  onConnect,
  checkConnect,
  onDeleteSelection,
  onDropAgent,
  onAutoArrange,
  emptyState,
  children,
}: CanvasProps): JSX.Element {
  const [view, setView] = useState<View>({ pan: { x: 0, y: 0 }, zoom: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const panRef = useRef<PanState | null>(null);
  const connectRef = useRef<ConnectState | null>(null);
  const [ghost, setGhost] = useState<{ from: string; to: Point; refused: boolean } | null>(null);
  const [armedFrom, setArmedFrom] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const editable = onConnect !== undefined;
  const result = validate(graph);

  const localPoint = useCallback((event: { clientX: number; clientY: number }): Point => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }, []);

  const capture = (pointerId: number): void => {
    const el = surfaceRef.current;
    if (el !== null && typeof el.setPointerCapture === 'function') {
      try {
        el.setPointerCapture(pointerId);
      } catch {
        /* a pointer that already ended cannot be captured; nothing to do */
      }
    }
  };

  // Wheel: a NATIVE, non-passive listener. React registers wheel listeners as
  // passive, so `preventDefault` from `onWheel` is ignored (with a console
  // warning) and the page scrolls under the canvas.
  useEffect(() => {
    const el = surfaceRef.current;
    if (el === null) return undefined;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        // Trackpad pinch arrives as ctrl+wheel.
        const rect = el.getBoundingClientRect();
        const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        setView(zoomAround(viewRef.current, cursor, viewRef.current.zoom * Math.exp(-event.deltaY * 0.01)));
      } else {
        setView((v) => ({ ...v, pan: { x: v.pan.x - event.deltaX, y: v.pan.y - event.deltaY } }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const handleBackgroundPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return; // a node card owns its own pointerdown
    panRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: viewRef.current.pan.x,
      startPanY: viewRef.current.pan.y,
      moved: false,
    };
    capture(event.pointerId);
  }, []);

  const handleNodeDragStart = useCallback(
    (nodeId: string, event: React.PointerEvent<HTMLDivElement>) => {
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) return;
      event.stopPropagation(); // don't also start a pan on the background handler
      dragRef.current = {
        nodeId,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startNodeX: node.x,
        startNodeY: node.y,
      };
      if (onNodeMove !== undefined) capture(event.pointerId);
      // Select on press, not on click: with the pointer captured, the browser
      // delivers the click to the capturing surface, never to the card.
      onSelect(nodeId);
    },
    [graph.nodes, onNodeMove, onSelect],
  );

  const handleOutputPointerDown = useCallback((nodeId: string, event: React.PointerEvent<HTMLElement>) => {
    connectRef.current = {
      from: nodeId,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
    };
    capture(event.pointerId);
  }, []);

  /** Where a connect gesture currently points: the input port under the
   *  cursor (if any) and, if it is one, whether the owner would refuse it. */
  const connectTarget = useCallback(
    (from: string, event: { clientX: number; clientY: number }) => {
      const world = screenToWorld(localPoint(event), viewRef.current);
      const target = hitInputPort(graph, world, CONNECT_RADIUS, from);
      const reason = target === null ? null : (checkConnect?.(from, target) ?? null);
      const targetNode = target === null ? undefined : graph.nodes.find((n) => n.id === target);
      return { world, target, reason, snap: targetNode === undefined ? world : portCenter(targetNode, 'in') };
    },
    [graph, localPoint, checkConnect],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const connect = connectRef.current;
      if (connect && connect.pointerId === event.pointerId) {
        if (Math.hypot(event.clientX - connect.startClientX, event.clientY - connect.startClientY) >= DRAG_THRESHOLD) {
          connect.moved = true;
        }
        if (connect.moved) {
          const { reason, snap } = connectTarget(connect.from, event);
          setGhost({ from: connect.from, to: snap, refused: reason !== null });
          setNote(reason);
        }
        return;
      }
      const drag = dragRef.current;
      if (drag && drag.pointerId === event.pointerId) {
        const dx = (event.clientX - drag.startClientX) / viewRef.current.zoom;
        const dy = (event.clientY - drag.startClientY) / viewRef.current.zoom;
        onNodeMove?.(drag.nodeId, drag.startNodeX + dx, drag.startNodeY + dy);
        return;
      }
      const panState = panRef.current;
      if (panState && panState.pointerId === event.pointerId) {
        const ddx = event.clientX - panState.startClientX;
        const ddy = event.clientY - panState.startClientY;
        if (Math.hypot(ddx, ddy) >= DRAG_THRESHOLD) panState.moved = true;
        setView((v) => ({ ...v, pan: { x: panState.startPanX + ddx, y: panState.startPanY + ddy } }));
      }
    },
    [onNodeMove, connectTarget],
  );

  const endGesture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const connect = connectRef.current;
      if (connect && connect.pointerId === event.pointerId) {
        connectRef.current = null;
        setGhost(null);
        if (event.type === 'pointercancel') return;
        const { target } = connectTarget(connect.from, event);
        if (target !== null && connect.moved) {
          setNote(onConnect?.(connect.from, target) ?? null);
          setArmedFrom(null);
        } else if (!connect.moved) {
          // A tap on the port, not a drag: arm it, so the next tap on another
          // card's top port connects (touch, and anyone not dragging).
          setArmedFrom((current) => (current === connect.from ? null : connect.from));
          setNote(null);
        } else {
          setNote(null); // released on nothing: cancelled, no edge
        }
        return;
      }
      if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
      const panState = panRef.current;
      if (panState?.pointerId === event.pointerId) {
        panRef.current = null;
        if (!panState.moved && event.type === 'pointerup') {
          onClearSelection?.();
          setArmedFrom(null);
          setNote(null);
        }
      }
    },
    [connectTarget, onConnect, onClearSelection],
  );

  const ports: NodePorts | undefined = editable
    ? {
        armedFrom,
        onOutputPointerDown: handleOutputPointerDown,
        onOutputActivate: (nodeId, event) => {
          // A mouse/touch click was already handled by the pointer path (it
          // arms on a tap); only a keyboard activation (detail 0) arrives here
          // unhandled.
          if (event.detail !== 0) return;
          setArmedFrom((current) => (current === nodeId ? null : nodeId));
          setNote(null);
        },
        onInputActivate: (nodeId) => {
          if (armedFrom === null) return;
          setNote(onConnect?.(armedFrom, nodeId) ?? null);
          setArmedFrom(null);
        },
      }
    : undefined;

  const hasSelection = selectedNodeId !== null || selectedEdge !== null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      setArmedFrom(null);
      setNote(null);
      return;
    }
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    // Typing in a text field must NEVER delete the selected node. The
    // Inspector's inputs are not inside this element today, but a handler on
    // a focusable root fires for any descendant, so guard by event target.
    if (isTextEntry(event.target)) return;
    if (onDeleteSelection === undefined || !hasSelection) return;
    event.preventDefault();
    onDeleteSelection();
  };

  const surface = view;
  const armedName =
    armedFrom === null ? null : (graph.nodes.find((n) => n.id === armedFrom)?.displayName ?? armedFrom);

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-bg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      aria-label="Workflow canvas"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {!result.ok && (
        <div
          role="alert"
          className="absolute inset-x-0 top-0 z-10 border-b border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
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
        ref={surfaceRef}
        data-canvas-surface=""
        className="absolute inset-0 cursor-default touch-none"
        onPointerDown={handleBackgroundPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onDragOver={(event) => {
          if (onDropAgent !== undefined && event.dataTransfer.types.includes(AGENT_DRAG_TYPE)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDrop={(event) => {
          const payload = event.dataTransfer.getData(AGENT_DRAG_TYPE);
          if (onDropAgent === undefined || payload === '') return;
          event.preventDefault();
          onDropAgent(payload, screenToWorld(localPoint(event), viewRef.current));
        }}
      >
        <div
          data-canvas-layer=""
          className="absolute left-0 top-0"
          style={{
            transform: `translate(${surface.pan.x}px, ${surface.pan.y}px) scale(${surface.zoom})`,
            transformOrigin: '0 0',
          }}
        >
          <Edges
            nodes={graph.nodes}
            edges={graph.edges}
            selectedNodeId={selectedNodeId}
            selectedEdge={selectedEdge}
            {...(onSelectEdge === undefined ? {} : { onSelectEdge })}
            ghost={ghost}
          />
          {graph.nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              selected={node.id === selectedNodeId}
              onSelect={onSelect}
              onDragStart={handleNodeDragStart}
              {...(ports === undefined ? {} : { ports })}
            />
          ))}
          {children}
        </div>
      </div>

      {graph.nodes.length === 0 && emptyState !== undefined && (
        <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center p-4">
          <div className="pointer-events-auto max-w-md">{emptyState}</div>
        </div>
      )}

      {(note !== null || armedName !== null) && (
        <div
          role="status"
          className={`absolute bottom-2 left-2 z-10 max-w-[70%] rounded-md border px-2 py-1 text-xs ${
            note !== null ? 'border-danger/50 bg-danger/10 text-danger' : 'border-accent/50 bg-surface-2 text-fg'
          }`}
        >
          {note ?? `Connecting from ${armedName}: use the top dot of the agent that should run after it. Esc cancels.`}
        </div>
      )}

      <div className="absolute bottom-2 right-2 z-10 flex items-center gap-1">
        {editable && onDeleteSelection !== undefined && (
          <button
            type="button"
            aria-label="Delete selected"
            title="Delete selected"
            disabled={!hasSelection}
            onClick={onDeleteSelection}
            className={TOOL_BUTTON}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        )}
        {onAutoArrange !== undefined && (
          <button
            type="button"
            aria-label="Auto-arrange"
            title="Auto-arrange"
            disabled={graph.nodes.length === 0}
            onClick={onAutoArrange}
            className={TOOL_BUTTON}
          >
            <Network size={14} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          aria-label="Fit to view"
          title="Fit to view"
          onClick={() => {
            const rect = surfaceRef.current?.getBoundingClientRect();
            setView(fitView(graph.nodes, { width: rect?.width ?? 0, height: rect?.height ?? 0 }));
          }}
          className={TOOL_BUTTON}
        >
          <Maximize2 size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => setView((v) => ({ ...v, zoom: clampZoom(v.zoom / 1.2) }))}
          className={TOOL_BUTTON}
        >
          <ZoomOut size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => setView((v) => ({ ...v, zoom: clampZoom(v.zoom * 1.2) }))}
          className={TOOL_BUTTON}
        >
          <ZoomIn size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
