import { useState } from 'react';
// No `Github` icon: lucide removed brand marks upstream and this project is on
// lucide-react 1.x. `GitPullRequest` is the better signifier anyway — the chip
// says where a publish lands, not which vendor hosts it.
import { Check, Command, GitPullRequest, Link2 } from 'lucide-react';
import type { GithubRepoRef } from '@syncode/protocol/events';
import type { PresenceEntry } from '@syncode/protocol/wire';
// Sibling of Task 1 (docs/plans/phase-5b-room-ui-redesign.md). Not present on
// disk at the time this file was written under parallel dispatch — imported
// by its documented path and `{ status, now }` props per the plan. Expected
// to resolve once that task lands; report this as the integration seam.
import { AgentActivity } from './AgentActivity.js';
import type { AgentStatus } from '../agentStatus.js';
import { Roster } from './Roster.js';

export interface RoomHeaderProps {
  /** Repo name from `room_created`, else the short room id. Never the token. */
  roomLabel: string;
  /** Full shareable room URL, for the copy-link button. Never logged, I4. */
  roomLink: string;
  participants: PresenceEntry[];
  driverId: string | null;
  selfId: string | null;
  agentStatus: AgentStatus;
  now: number;
  /**
   * The repository a publish would open a pull request against, derived from
   * `room_created` (see `deriveGithubBinding`). Null for a room with no GitHub
   * binding — which is also a room with no publish tool at all, since
   * `createGithubMcpServer` returns null in that case. Showing it makes "this
   * room can publish, and where" visible rather than something the agent
   * discovers by trying.
   */
  github: GithubRepoRef | null;
  onRequestControl: () => void;
  onReleaseControl: () => void;
  onGrantControl: (participantId: string) => void;
  /** Opens the ⌘K room switcher. The modal itself is composed by App.tsx. */
  onOpenSwitcher: () => void;
  /** Opens the `?` shortcut cheatsheet. The modal itself is composed by App.tsx. */
  onOpenCheatsheet: () => void;
}

/**
 * The top header region: wordmark, room label with a copy-link control, the
 * participant avatar row, live agent activity, and triggers for the room
 * switcher and the shortcut cheatsheet. Sticky (`z-10`) per MASTER.md's
 * z-index scale — never a bare `z-[9999]`.
 */
export function RoomHeader({
  roomLabel,
  roomLink,
  participants,
  driverId,
  selfId,
  agentStatus,
  now,
  github,
  onRequestControl,
  onReleaseControl,
  onGrantControl,
  onOpenSwitcher,
  onOpenCheatsheet,
}: RoomHeaderProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  async function handleCopyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(roomLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied (permissions, insecure context). Silent
      // failure is acceptable here — the link is still visible/selectable in
      // the UI; there is nothing destructive or unsafe about not copying.
    }
  }

  return (
    <header className="sticky top-0 z-10 flex min-h-[56px] items-center justify-between gap-4 border-b border-border bg-surface px-4 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <span className="shrink-0 text-lg font-semibold text-fg">SynCode</span>
        <span className="truncate text-sm text-fg-muted">{roomLabel}</span>
        <button
          type="button"
          onClick={() => void handleCopyLink()}
          aria-label="Copy room link"
          title="Copy room link"
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-fg-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {copied ? (
            <Check size={16} className="text-accent" aria-hidden="true" />
          ) : (
            <Link2 size={16} aria-hidden="true" />
          )}
        </button>
        {github !== null && (
          <a
            href={`https://github.com/${github.owner}/${github.repo}`}
            target="_blank"
            // noreferrer is load-bearing, not boilerplate: the room token is in
            // this page's query string and would otherwise reach GitHub in the
            // Referer header. Mirrors the server's Referrer-Policy.
            rel="noopener noreferrer"
            title={`Publishing opens a pull request on ${github.owner}/${github.repo} (${github.defaultBranch})`}
            className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded border border-border px-2 text-xs text-fg-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            <GitPullRequest size={14} aria-hidden="true" />
            <span className="truncate">{`${github.owner}/${github.repo}`}</span>
          </a>
        )}
      </div>

      <div className="flex min-w-0 items-center gap-3">
        <Roster
          participants={participants}
          driverId={driverId}
          selfId={selfId}
          onRequestControl={onRequestControl}
          onReleaseControl={onReleaseControl}
          onGrantControl={onGrantControl}
        />
        <AgentActivity status={agentStatus} now={now} />
        <button
          type="button"
          onClick={onOpenSwitcher}
          aria-label="Open room switcher"
          title="Open room switcher (⌘K)"
          className="flex min-h-[44px] items-center gap-1 rounded border border-border px-2 text-fg-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <Command size={16} aria-hidden="true" />
          <kbd className="font-mono text-xs text-fg-muted">⌘K</kbd>
        </button>
        <button
          type="button"
          onClick={onOpenCheatsheet}
          aria-label="Open keyboard shortcut cheatsheet"
          title="Keyboard shortcuts (?)"
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-border text-fg-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          ?
        </button>
      </div>
    </header>
  );
}
