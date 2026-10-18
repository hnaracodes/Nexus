import { Plus } from 'lucide-react';
import type { SavedConfig } from './api.js';
import { AGENT_DRAG_TYPE } from './Canvas.js';
import { PRESETS } from './presets.js';

export interface PaletteProps {
  configs: readonly SavedConfig[];
  /** `preset:<key>` or `config:<name>`. */
  onAdd: (payload: string) => void;
  /** 'sidebar' lists everything; 'menu' is the collapsed form for narrow widths. */
  variant: 'sidebar' | 'menu';
}

export function presetPayload(key: string): string {
  return `preset:${key}`;
}
export function configPayload(name: string): string {
  return `config:${name}`;
}

const ENTRY =
  'flex w-full min-w-0 items-center gap-2 rounded-md border border-border bg-bg px-2 py-1.5 text-left text-xs text-fg ' +
  'hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/**
 * Agents you can add to the canvas: the four presets, then any other saved
 * config. Click to add, or drag onto the canvas. Adding a node never starts an
 * agent - it only draws one; running is a separate, driver-only step.
 */
export function Palette({ configs, onAdd, variant }: PaletteProps): JSX.Element {
  const presetNames = new Set(PRESETS.map((p) => p.name));
  const others = configs.filter((c) => !presetNames.has(c.name));

  const entry = (payload: string, label: string, hint: string): JSX.Element => (
    <li key={payload}>
      <button
        type="button"
        draggable
        title={hint}
        onClick={() => onAdd(payload)}
        onDragStart={(event) => {
          event.dataTransfer.setData(AGENT_DRAG_TYPE, payload);
          event.dataTransfer.effectAllowed = 'copy';
        }}
        className={ENTRY}
      >
        <Plus size={12} className="shrink-0 text-fg-muted" aria-hidden="true" />
        <span className="min-w-0 truncate">{label}</span>
      </button>
    </li>
  );

  const list = (
    <ul className="flex flex-col gap-1" aria-label="Agents to add">
      {PRESETS.map((p) => entry(presetPayload(p.key), p.name, p.description))}
      {others.map((c) => entry(configPayload(c.name), c.name, c.description || 'Saved config'))}
    </ul>
  );

  if (variant === 'menu') {
    return (
      <details className="border-b border-border bg-surface px-2 py-1 text-xs">
        <summary className="cursor-pointer select-none py-1 text-fg-muted">+ Add agent to canvas</summary>
        <div className="pb-2">{list}</div>
      </details>
    );
  }
  return (
    <aside aria-label="Palette" className="flex w-48 shrink-0 flex-col gap-2 overflow-y-auto border-r border-border bg-surface p-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Add to canvas</h3>
      {list}
      <p className="text-[11px] text-fg-muted">Click or drag. Adding only draws an agent; nothing runs until you Run.</p>
    </aside>
  );
}
