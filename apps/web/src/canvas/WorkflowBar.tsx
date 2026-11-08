import { useState } from 'react';
import { Play, Save, Trash2 } from 'lucide-react';
import type { SavedCrew } from './api.js';

/** What a run sends when the task box is left empty. Shown as the placeholder
 *  so the person sees exactly what will be sent. */
export const DEFAULT_TASK =
  'Work through the project in this workspace and do your part of this workflow. Report what you did and what you found.';

export interface WorkflowBarProps {
  crews: readonly SavedCrew[];
  loadedName: string | null;
  name: string;
  onName: (name: string) => void;
  task: string;
  onTask: (task: string) => void;
  onLoad: (crewName: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onRun: () => void;
  /** Why Save is unavailable, in words; null when it is available. */
  saveBlocker: string | null;
  /** Why Run is unavailable, in words; null when it is available. */
  runBlocker: string | null;
  /** Saving under this name would replace a different saved workflow. */
  willReplace: boolean;
  busy: boolean;
}

const FIELD =
  'min-w-0 rounded-md border border-border-strong bg-bg px-2 py-1 text-xs text-fg placeholder:text-fg-muted ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
const BTN =
  'inline-flex h-8 shrink-0 items-center gap-1 rounded-md border px-2.5 text-xs font-medium ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50';

export function WorkflowBar(props: WorkflowBarProps): JSX.Element {
  const { crews, loadedName, name, task, saveBlocker, runBlocker, willReplace, busy } = props;
  const [confirming, setConfirming] = useState(false);
  const blocker = runBlocker ?? saveBlocker;

  return (
    <section aria-label="Workflow" className="flex flex-col gap-1 border-b border-border bg-surface px-2 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <select
          aria-label="Saved workflows"
          value={loadedName ?? ''}
          onChange={(event) => event.target.value !== '' && props.onLoad(event.target.value)}
          className={`${FIELD} max-w-[10rem]`}
        >
          <option value="">{crews.length === 0 ? 'No saved workflows' : 'Open workflow...'}</option>
          {crews.map((c) => (
            <option key={c.name} value={c.name} disabled={c.graph === undefined}>
              {c.graph === undefined ? `${c.name} (no graph - launch from Configs)` : c.name}
            </option>
          ))}
        </select>
        <input
          aria-label="Workflow name"
          value={name}
          onChange={(event) => {
            setConfirming(false);
            props.onName(event.target.value);
          }}
          placeholder="Untitled workflow"
          maxLength={80}
          className={`${FIELD} w-40`}
        />
        {confirming ? (
          <span role="alert" className="inline-flex items-center gap-1 text-xs text-warn">
            Replace workflow &quot;{name.trim()}&quot;?
            <button
              type="button"
              className={`${BTN} border-warn text-warn hover:bg-warn/10`}
              onClick={() => {
                setConfirming(false);
                props.onSave();
              }}
            >
              Replace
            </button>
            <button type="button" className={`${BTN} border-border-strong text-fg-muted`} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            disabled={busy || saveBlocker !== null}
            title={saveBlocker ?? 'Save this workflow'}
            onClick={() => (willReplace ? setConfirming(true) : props.onSave())}
            className={`${BTN} border-border-strong bg-surface-2 text-fg hover:bg-muted`}
          >
            <Save size={13} aria-hidden="true" />
            Save
          </button>
        )}
        <button
          type="button"
          disabled={busy || loadedName === null}
          title={loadedName === null ? 'Open a saved workflow to delete it' : `Delete "${loadedName}"`}
          onClick={props.onDelete}
          className={`${BTN} border-danger/45 text-danger hover:bg-danger/10`}
        >
          <Trash2 size={13} aria-hidden="true" />
          Delete
        </button>

        <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden="true" />

        <label className="flex min-w-0 flex-1 items-center gap-1 text-xs text-fg-muted">
          <span className="shrink-0">Task</span>
          <input
            aria-label="Task"
            value={task}
            onChange={(event) => props.onTask(event.target.value)}
            placeholder={DEFAULT_TASK}
            className={`${FIELD} w-full`}
          />
        </label>
        <button
          type="button"
          disabled={busy || runBlocker !== null}
          title={runBlocker ?? 'Run this workflow'}
          onClick={props.onRun}
          className={`${BTN} border-transparent bg-accent text-on-accent hover:brightness-110`}
        >
          <Play size={13} aria-hidden="true" />
          Run
        </button>
      </div>
      <p className="text-[11px] text-fg-muted">
        Starts under the current driver&apos;s name. Every agent still asks the room for approval before it acts.
      </p>
      {blocker !== null && (
        <p data-testid="workflow-blocker" className="text-[11px] text-fg-muted">
          {blocker}
        </p>
      )}
    </section>
  );
}
