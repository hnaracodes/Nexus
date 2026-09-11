import { GitBranch, User, Users } from 'lucide-react';
import type { NexusEvent } from '@syncode/protocol/events';
import type { PresenceEntry } from '@syncode/protocol/wire';
import type { Status } from '../ws.js';
import { deriveGithubBinding } from '../githubBinding.js';
import { ConnectionStatus } from './ConnectionStatus.js';

/**
 * Region E: the thin status line along the bottom of the shell. Reuses
 * `ConnectionStatus` outright (it is already "correct" per the brief) rather
 * than re-deriving connection state; the repo/branch text is the same
 * derivation `RepoBranchBar` uses (`deriveGithubBinding`, plus the
 * `nexus/<roomId>` convention `publish.ts` actually writes to — see
 * `RepoBranchBar`'s own doc comment) rendered inline instead of as a
 * bordered chip, since a status bar is one continuous line, not a row of
 * cards.
 */
export function StatusBar({
  events,
  roomId,
  participants,
  driverId,
  agentCount,
  status,
}: {
  events: NexusEvent[];
  roomId: string;
  participants: PresenceEntry[];
  driverId: string | null;
  agentCount: number;
  status: Status;
}): JSX.Element {
  const github = deriveGithubBinding(events);
  const driverName =
    driverId === null
      ? 'No driver'
      : (participants.find((p) => p.participantId === driverId)?.displayName ?? 'Unknown driver');

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-surface px-2 text-[11px] text-fg-muted">
      {github !== null ? (
        <span className="flex min-w-0 items-center gap-1" title={`${github.owner}/${github.repo}`}>
          <GitBranch size={12} aria-hidden="true" />
          <span className="truncate font-mono">{`nexus/${roomId}`}</span>
        </span>
      ) : (
        <span className="flex items-center gap-1">
          <GitBranch size={12} aria-hidden="true" />
          <span>No repository</span>
        </span>
      )}

      <span className="flex items-center gap-1" title="Who is driving">
        <User size={12} aria-hidden="true" />
        <span>{driverName}</span>
      </span>

      <span className="flex items-center gap-1" title="Agents in this room">
        <Users size={12} aria-hidden="true" />
        <span>
          {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
        </span>
      </span>

      <span className="ml-auto flex items-center">
        <ConnectionStatus status={status} />
      </span>
    </footer>
  );
}
