import type { AgentProvider } from '@syncode/protocol/events';
import type { Node } from './graph.js';
import { NODE_HEIGHT, NODE_WIDTH } from './graphOps.js';

/**
 * Anchor geometry lives in `graphOps.ts` (re-exported here for existing
 * importers). A node's on-screen size has to be DATA, not a CSS-measured fact:
 * jsdom never lays anything out, and the edge layer computes a line's
 * endpoints from `node.x`/`node.y` alone.
 */
export { NODE_HEIGHT, NODE_WIDTH };

const PROVIDER_LABEL: Record<AgentProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

/** Connection ports. Present only on an editable canvas. */
export interface NodePorts {
  /** The node whose output port is armed for click-to-connect, if any. */
  armedFrom: string | null;
  onOutputPointerDown: (nodeId: string, event: React.PointerEvent<HTMLElement>) => void;
  onOutputActivate: (nodeId: string, event: React.MouseEvent<HTMLElement>) => void;
  onInputActivate: (nodeId: string) => void;
}

export interface NodeCardProps {
  node: Node;
  selected: boolean;
  onSelect: (nodeId: string) => void;
  /** Starts a drag. Omitted by a read-only consumer of this card. */
  onDragStart?: (nodeId: string, event: React.PointerEvent<HTMLDivElement>) => void;
  ports?: NodePorts;
}

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-bg';

const PORT =
  'absolute left-1/2 z-10 h-3.5 w-3.5 -translate-x-1/2 rounded-full border-2 bg-surface ' +
  // A 14px dot is a poor touch target; the pseudo-element grows the HIT area
  // without growing the dot.
  "before:absolute before:-inset-2 before:content-[''] " +
  FOCUS_RING;

/**
 * One workflow node - an agent built from a saved config (phase 13), not a new
 * kind of thing. Shows what a driver needs to judge it at a glance: display
 * name, provider/model, and which config it came from.
 *
 * `role="button"` on a `div`, not a real `<button>`: this element carries both
 * click-to-select AND pointer-drag-to-move, and it now contains the two port
 * buttons (a button inside a button is invalid HTML). Keyboard users lose
 * nothing - Enter/Space select exactly like a button would, but ONLY when the
 * card itself is the target, so activating a port with the keyboard does not
 * also select the card and swallow the activation.
 */
export function NodeCard({ node, selected, onSelect, onDragStart, ports }: NodeCardProps): JSX.Element {
  const armed = ports?.armedFrom === node.id;
  const someoneArmed = ports !== undefined && ports.armedFrom !== null && ports.armedFrom !== node.id;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${node.displayName}, ${PROVIDER_LABEL[node.provider]} agent from ${node.configName}`}
      data-node-id={node.id}
      onClick={() => onSelect(node.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        // Space also scrolls the page on a plain div - preventDefault before
        // selecting, not after, so a keyboard user never sees the canvas jump.
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(node.id);
        }
      }}
      onPointerDown={(event) => onDragStart?.(node.id, event)}
      style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={`absolute flex cursor-grab flex-col justify-center gap-1 rounded-lg border bg-surface px-3 py-2 text-left ${FOCUS_RING} ${
        selected ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-border-strong'
      }`}
    >
      <span className="truncate text-sm font-medium text-fg">{node.displayName}</span>
      <span className="truncate text-xs text-fg-muted">
        {PROVIDER_LABEL[node.provider]} · {node.model ?? 'default model'}
      </span>
      <span className="truncate text-[11px] text-fg-muted">{node.configName}</span>
      {ports !== undefined && (
        <>
          <button
            type="button"
            data-port="in"
            data-node-id={node.id}
            aria-label={`Connect into ${node.displayName}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              ports.onInputActivate(node.id);
            }}
            style={{ top: -7 }}
            className={`${PORT} ${someoneArmed ? 'border-accent' : 'border-border-strong'}`}
          />
          <button
            type="button"
            data-port="out"
            data-node-id={node.id}
            aria-label={`Connect from ${node.displayName}`}
            aria-pressed={armed}
            onPointerDown={(event) => {
              event.stopPropagation();
              ports.onOutputPointerDown(node.id, event);
            }}
            onClick={(event) => {
              event.stopPropagation();
              ports.onOutputActivate(node.id, event);
            }}
            style={{ bottom: -7 }}
            className={`${PORT} ${armed ? 'border-accent bg-accent' : 'border-border-strong'}`}
          />
        </>
      )}
    </div>
  );
}
