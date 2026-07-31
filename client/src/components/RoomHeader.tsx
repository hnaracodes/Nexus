import { useState } from 'react';
import { Check, Command, Link2 } from 'lucide-react';
import type { PresenceEntry } from '../../../src/protocol/wire.js';
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
        <span className="shrink-0 text-lg font-semibold text-fg">Nexus</span>
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
