import { useEffect, useRef, useState } from 'react';
// No `Github` icon: lucide removed brand marks upstream and this project is on
// lucide-react 1.x. `GitPullRequest` is the better signifier anyway — the chip
// says where a publish lands, not which vendor hosts it.
import { Check, Command, GitPullRequest, Globe, Link2, PanelRight, Zap } from 'lucide-react';
import type { GithubRepoRef } from '@syncode/protocol/events';
import type { PresenceEntry } from '@syncode/protocol/wire';
// Sibling of Task 1 (docs/plans/phase-5b-room-ui-redesign.md). Not present on
// disk at the time this file was written under parallel dispatch — imported
// by its documented path and `{ status, now }` props per the plan. Expected
// to resolve once that task lands; report this as the integration seam.
import { AgentActivity } from './AgentActivity.js';
import type { AgentStatus } from '../agentStatus.js';
import type { AutoModeState } from '../derive/autoMode.js';
import { Roster } from './Roster.js';
import type { ShareScope, ShareableRoomLink } from '../shareLink.js';

export interface RoomHeaderProps {
  /** Repo name from `room_created`, else the short room id. Never the token. */
  roomLabel: string;
  /**
   * The link the copy button hands out and what it reaches (see
   * `shareableRoomLink`). Never carries a display name. Never logged, I4.
   * `scope === 'web'` also drives the "Shared on the web" indicator.
   */
  shareLink: ShareableRoomLink;
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
  /** Who has auto mode on, or null (phase 19a). Derived from the log. */
  autoMode: AutoModeState | null;
  /** Ask the server to switch auto mode. Anyone may, in either direction. */
  onSetAutoMode: (enabled: boolean) => void;
  /** Whether the right-hand agent bar is open (drives `aria-pressed`). */
  auxOpen: boolean;
  /** Toggle the agent bar: the by-mouse twin of mod+alt+b. */
  onToggleAux: () => void;
  /**
   * Pending approvals. Shown on the toggle only while the bar is CLOSED, so a
   * collapsed agent bar can never hide that the room is waiting on a decision.
   */
  pendingApprovals?: number;
}

/** How long the "only works on this computer" notice stays up after a copy. */
const LOCAL_NOTICE_MS = 8000;

const LOCAL_NOTICE =
  'Copied. This link only works on this computer. Use Room → Share on the Web to invite someone elsewhere.';

/** Tooltip and accessible name of the copy button, per what the link reaches. */
const COPY_TEXT: Record<ShareScope, { title: string; label: string }> = {
  web: {
    title: 'Copy the web link (anyone with it can join from anywhere)',
    label: 'Copy the web link (anyone with it can join from anywhere)',
  },
  lan: {
    title: 'Copy the local network link (anyone with it can join from your local network)',
    label: 'Copy the local network link (anyone with it can join from your local network)',
  },
  local: {
    title: 'This room is only on this computer. Use Room → Share on the Web to invite someone elsewhere.',
    label: 'Copy room link (this room is only on this computer)',
  },
  public: { title: 'Copy room link', label: 'Copy room link' },
};

/**
 * The top header region: wordmark, room label with a copy-link control, the
 * participant avatar row, live agent activity, and triggers for the room
 * switcher and the shortcut cheatsheet. Sticky (`z-10`) per MASTER.md's
 * z-index scale — never a bare `z-[9999]`.
 */
export function RoomHeader({
  roomLabel,
  shareLink,
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
  autoMode,
  onSetAutoMode,
  auxOpen,
  onToggleAux,
  pendingApprovals = 0,
}: RoomHeaderProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [localNoticeShown, setLocalNoticeShown] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // No state updates after unmount: a header that unmounts (room switch) must
  // not be written to by a timer started before it went away.
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const copyText = COPY_TEXT[shareLink.scope];
  // Derived, not stored: if the scope changes (the host starts sharing) a
  // notice about the old scope must not outlive it.
  const showLocalNotice = localNoticeShown && shareLink.scope === 'local';

  async function handleCopyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(shareLink.url);
      setCopied(true);
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
      if (shareLink.scope === 'local') {
        // The link is real but only opens on this computer. Say so right after
        // the copy, where the person is looking, instead of letting them send
        // it to someone it cannot reach. Inline: no modal, no alert().
        setLocalNoticeShown(true);
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => setLocalNoticeShown(false), LOCAL_NOTICE_MS);
      }
    } catch {
      // Clipboard access can be denied (permissions, insecure context). Silent
      // failure is acceptable here — the link is still visible/selectable in
      // the UI; there is nothing destructive or unsafe about not copying.
    }
  }

  return (
    <header className="sticky top-0 z-10 flex h-8 shrink-0 items-center justify-between gap-4 border-b border-border bg-titlebar px-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="shrink-0 text-[13px] font-semibold text-fg">SynCode</span>
        <span className="truncate text-xs text-fg-muted">{roomLabel}</span>
        <button
          type="button"
          onClick={() => void handleCopyLink()}
          aria-label={copyText.label}
          title={copyText.title}
          className="flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {copied ? (
            <Check size={14} className="text-accent-fg" aria-hidden="true" />
          ) : (
            <Link2 size={14} aria-hidden="true" />
          )}
        </button>
        {showLocalNotice && (
          <span role="status" title={LOCAL_NOTICE} className="truncate text-xs text-warn">
            {LOCAL_NOTICE}
          </span>
        )}
        {shareLink.scope === 'web' && (
          <span
            title="This room is shared on the web: anyone with the link can join. Stop sharing from the Room menu."
            className="flex h-6 shrink-0 items-center gap-1.5 rounded border border-accent bg-accent/15 px-2 text-xs text-fg"
          >
            <Globe size={12} aria-hidden="true" className="text-accent-fg" />
            <span>Shared on the web</span>
          </span>
        )}
        {github !== null && (
          <a
            href={`https://github.com/${github.owner}/${github.repo}`}
            target="_blank"
            // noreferrer is load-bearing, not boilerplate: the room token is in
            // this page's query string and would otherwise reach GitHub in the
            // Referer header. Mirrors the server's Referrer-Policy.
            rel="noopener noreferrer"
            title={`Publishing opens a pull request on ${github.owner}/${github.repo} (${github.defaultBranch})`}
            className="flex h-6 shrink-0 items-center gap-1.5 rounded border border-border px-2 text-xs text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
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
        {/* Phase 19a. A real switch (role + aria-checked), not a styled
            checkbox, so its state is announced, not only coloured. */}
        <button
          type="button"
          role="switch"
          aria-checked={autoMode !== null}
          aria-label="Auto mode"
          title={
            autoMode !== null
              ? `Auto mode is on (turned on by ${autoMode.displayName}): agent edits and commands run without a vote. Click to turn off.`
              : 'Auto mode is off: the room votes on agent edits and commands. Click to approve them automatically.'
          }
          onClick={() => onSetAutoMode(autoMode === null)}
          className={`flex h-6 shrink-0 items-center gap-1 rounded border px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
            autoMode !== null
              ? 'border-accent bg-accent/15 text-fg'
              : 'border-border text-fg-muted hover:text-fg'
          }`}
        >
          <Zap size={12} aria-hidden="true" className={autoMode !== null ? 'text-accent-fg' : undefined} />
          <span>{autoMode !== null ? 'Auto: on' : 'Auto: off'}</span>
        </button>
        <button
          type="button"
          onClick={onOpenSwitcher}
          aria-label="Open room switcher"
          title="Open room switcher (⌘K)"
          className="flex h-6 items-center gap-1 rounded border border-border px-2 text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <Command size={12} aria-hidden="true" />
          <kbd className="font-mono text-xs text-fg-muted">⌘K</kbd>
        </button>
        <button
          type="button"
          onClick={onOpenCheatsheet}
          aria-label="Open keyboard shortcut cheatsheet"
          title="Keyboard shortcuts (?)"
          className="flex h-6 w-6 items-center justify-center rounded border border-border text-xs text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          ?
        </button>
        <button
          type="button"
          onClick={onToggleAux}
          aria-pressed={auxOpen}
          aria-label="Toggle agent bar"
          title="Toggle agent bar (⌥⌘B)"
          className={`relative flex h-6 w-6 items-center justify-center rounded hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
            auxOpen ? 'text-fg' : 'text-fg-muted'
          }`}
        >
          <PanelRight size={14} aria-hidden="true" />
          {!auxOpen && pendingApprovals > 0 && (
            <span
              aria-label={`${pendingApprovals} pending in Approvals`}
              className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-semibold leading-none text-on-accent"
            >
              {pendingApprovals > 99 ? '99+' : pendingApprovals}
            </span>
          )}
        </button>
      </div>
    </header>
  );
}
