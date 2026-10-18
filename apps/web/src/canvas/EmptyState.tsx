import { PRESETS } from './presets.js';
import { presetPayload } from './Palette.js';

/** Shown on an empty canvas. The buttons ADD NODES; they start nothing. */
export function EmptyState({ onAdd }: { onAdd: (payload: string) => void }): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 text-center">
      <p className="text-sm text-fg">
        Agents work as a team here: add a few, connect them top to bottom, and run them as one workflow.
      </p>
      <div className="mt-3 flex flex-wrap justify-center gap-1.5" role="group" aria-label="Add a first agent">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            title={p.description}
            onClick={() => onAdd(presetPayload(p.key))}
            className="rounded-md border border-border-strong bg-surface-2 px-2.5 py-1 text-xs font-medium text-fg hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Add {p.name}
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs text-fg-muted">Or start a single agent now with the New agent buttons above.</p>
    </div>
  );
}
