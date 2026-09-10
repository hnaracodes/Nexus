import type { AgentProvider } from '@nexus/protocol/events';
import type { Node } from './graph.js';

/**
 * Anchor geometry shared with `Edges.tsx` and `Canvas.tsx`. A node's on-screen
 * size has to be DATA, not a CSS-measured fact: jsdom never lays anything
 * out (`getBoundingClientRect` comes back all zeros there), and the edge
 * layer computes a line's endpoints from `node.x`/`node.y` alone so it works
 * identically in a test and in a real browser.
 */
export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 84;

const PROVIDER_LABEL: Record<AgentProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

export interface NodeCardProps {
  node: Node;
  selected: boolean;
  onSelect: (nodeId: string) => void;
  /** Starts a drag. Omitted by a read-only consumer of this card (e.g. a
   *  future run overlay that shows the same graph but never moves it). */
  onDragStart?: (nodeId: string, event: React.PointerEvent<HTMLDivElement>) => void;
}

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-bg';

/**
 * One workflow node — an agent built from a saved config (phase 13), not a
 * new kind of thing (plan: "the canvas is a view over the orchestration
 * model, not a second model"). Shows exactly what a driver needs to judge it
 * at a glance: the display name, the provider/model, and which config it
 * came from.
 *
 * `role="button"` on a `div`, not a real `<button>`: this element carries
 * both click-to-select AND pointer-drag-to-move on the same node, and a
 * native button can swallow a drag's `pointerdown` mid-gesture on some
 * platforms. Keyboard users lose nothing — `Enter`/`Space` select exactly
 * like a button would, per the repo's existing pattern in `FileTree.tsx`.
 */
export function NodeCard({ node, selected, onSelect, onDragStart }: NodeCardProps): JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${node.displayName}, ${PROVIDER_LABEL[node.provider]} agent from ${node.configName}`}
      data-node-id={node.id}
      onClick={() => onSelect(node.id)}
      onKeyDown={(event) => {
        // Space also scrolls the page on a plain div — preventDefault before
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
    </div>
  );
}
