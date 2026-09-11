import { CheckCircle2, XCircle } from 'lucide-react';
import type { NexusEvent } from '@syncode/protocol/events';
import { deriveApprovals } from '../approvals.js';
import type { GitStatusEntry } from '../workspace/types.js';

export type GitStatusState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entries: GitStatusEntry[] };

export interface ChangesTabProps {
  events: NexusEvent[];
  gitStatus: GitStatusState;
}

const STATUS_LABEL: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Unmerged',
  '??': 'Untracked',
};

function statusLabel(code: string): string {
  return STATUS_LABEL[code.trim()] ?? code;
}

/**
 * Rehomes `SideRail`'s settled-approval history — the only real loss when
 * that component retires — reusing `deriveApprovals(events).settled`
 * verbatim, same derivation, new renderer. Git status renders below it.
 */
export function ChangesTab({ events, gitStatus }: ChangesTabProps): JSX.Element {
  const { settled } = deriveApprovals(events);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-3">
      <section aria-labelledby="changes-approvals">
        <h2 id="changes-approvals" className="mb-2 text-xs font-semibold uppercase text-fg-muted">
          Approval history
        </h2>
        {settled.length === 0 ? (
          <p className="text-xs text-fg-muted">No decisions yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {settled.map((approval) => (
              <li
                key={approval.requestId}
                className="flex items-start gap-2 rounded border border-border bg-surface px-2 py-1 text-xs"
              >
                {approval.decision === 'allow' ? (
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                ) : (
                  <XCircle size={14} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-fg">{approval.toolName}</span>{' '}
                  <span className="text-fg-muted">
                    {approval.decision === 'allow' ? 'approved' : 'denied'}
                    {approval.displayName !== null ? ` by ${approval.displayName}` : ' automatically'}
                  </span>
                  {approval.reason !== null && (
                    <span className="block text-fg-muted">&quot;{approval.reason}&quot;</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="changes-git-status">
        <h2 id="changes-git-status" className="mb-2 text-xs font-semibold uppercase text-fg-muted">
          Working tree
        </h2>
        {gitStatus.status === 'loading' && <p className="text-xs text-fg-muted">Loading git status…</p>}
        {gitStatus.status === 'error' && <p className="text-xs text-danger">{gitStatus.message}</p>}
        {gitStatus.status === 'ready' &&
          (gitStatus.entries.length === 0 ? (
            <p className="text-xs text-fg-muted">No uncommitted changes.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {gitStatus.entries.map((entry) => (
                <li
                  key={entry.path}
                  className="flex items-center gap-2 rounded border border-border bg-surface px-2 py-1 font-mono text-xs"
                >
                  <span className="w-20 shrink-0 uppercase text-fg-muted">{statusLabel(entry.status)}</span>
                  <span className="flex-1 truncate text-fg">{entry.path}</span>
                </li>
              ))}
            </ul>
          ))}
      </section>
    </div>
  );
}
