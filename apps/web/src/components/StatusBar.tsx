import { GitBranch, ShieldAlert, User, Users } from 'lucide-react';
import type { SynCodeEvent } from '@syncode/protocol/events';
import type { PresenceEntry } from '@syncode/protocol/wire';
import type { Status } from '../ws.js';
import { deriveGithubBinding } from '../githubBinding.js';
import { ConnectionStatus } from './ConnectionStatus.js';

const ITEM =
  'flex h-full items-center gap-1 px-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-status-fg';

/**
 * Region E: the VS Code status bar — accent-coloured, 22px.
 *
 * Left: connection (the item turns `status-error` red whenever the socket is
 * not open), branch, driver. Right: Ln/Col and language of the active file,
 * agent count (opens the Agents tab), and the approvals button.
 *
 * The approvals item is the always-visible half of the approvals guarantee: it
 * lives in the status bar, which nothing collapses, so a pending decision is
 * on screen even with the side bars and the panel all closed. With N > 0 it
 * takes the `status-alert` background and opens the Approvals view; with 0 it
 * stays (muted) and is still a button.
 */
export function StatusBar({
  events,
  roomId,
  participants,
  driverId,
  agentCount,
  status,
  cursor,
  language,
  approvalCount,
  onOpenAgents,
  onOpenApprovals,
}: {
  events: SynCodeEvent[];
  roomId: string;
  participants: PresenceEntry[];
  driverId: string | null;
  agentCount: number;
  status: Status;
  /** Caret of the active FILE tab (1-based), or null when there is none. */
  cursor?: { line: number; col: number } | null;
  /** Language label of the active file tab, or null when there is none. */
  language?: string | null;
  approvalCount: number;
  onOpenAgents: () => void;
  onOpenApprovals: () => void;
}): JSX.Element {
  const github = deriveGithubBinding(events);
  const driverName =
    driverId === null
      ? 'No driver'
      : (participants.find((p) => p.participantId === driverId)?.displayName ?? 'Unknown driver');
  const pending = approvalCount > 0;

  return (
    <footer className="flex h-[22px] shrink-0 items-stretch bg-status text-xs text-status-fg">
      <span className={`${ITEM} ${status === 'open' ? '' : 'bg-status-error'}`}>
        <ConnectionStatus status={status} variant="inline" />
      </span>

      {github !== null ? (
        <span className={`${ITEM} min-w-0`} title={`${github.owner}/${github.repo}`}>
          <GitBranch size={12} aria-hidden="true" />
          <span className="truncate font-mono">{`nexus/${roomId}`}</span>
        </span>
      ) : (
        <span className={ITEM}>
          <GitBranch size={12} aria-hidden="true" />
          <span>No repository</span>
        </span>
      )}

      <span className={ITEM} title="Who is driving">
        <User size={12} aria-hidden="true" />
        <span>{driverName}</span>
      </span>

      <span className="ml-auto flex items-stretch">
        {cursor != null && (
          <span className={ITEM} title="Cursor position">
            Ln {cursor.line}, Col {cursor.col}
          </span>
        )}
        {language != null && (
          <span className={ITEM} title="Language">
            {language}
          </span>
        )}
        <button
          type="button"
          onClick={onOpenAgents}
          title="Agents in this room — open the Agents tab"
          className={`${ITEM} hover:bg-status-fg/20`}
        >
          <Users size={12} aria-hidden="true" />
          <span>
            {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
          </span>
        </button>
        <button
          type="button"
          onClick={onOpenApprovals}
          aria-label={`${approvalCount} pending ${approvalCount === 1 ? 'approval' : 'approvals'} — open Approvals`}
          title="Open Approvals"
          className={`${ITEM} ${pending ? 'bg-status-alert font-semibold' : 'opacity-80 hover:bg-status-fg/20'}`}
        >
          <ShieldAlert size={12} aria-hidden="true" />
          <span>{approvalCount}</span>
        </button>
      </span>
    </footer>
  );
}
