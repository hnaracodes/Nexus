import { useEffect, useMemo, useRef, useState } from 'react';
import { deriveApprovals } from './approvals.js';
import type { PendingApproval } from './approvals.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { ConnectionStatus } from './components/ConnectionStatus.js';
import { ErrorBanner } from './components/ErrorBanner.js';
import { EMPTY_VIEW } from './store.js';
import type { RoomView } from './store.js';
import { connect } from './ws.js';
import type { Connection, Status, WebSocketLike } from './ws.js';
import type { NexusEvent } from '../../src/protocol/events.js';
// phase-5a import anchor
import { MalformedLink } from './pages/MalformedLink.js';
// phase-5b import anchor
import { useHotkeys } from './hooks/useHotkeys.js';
import type { Hotkey } from './hooks/useHotkeys.js';
import { RoomHeader } from './components/RoomHeader.js';
import { SideRail } from './components/SideRail.js';
import { MessageList } from './components/MessageList.js';
import { derivePending } from './components/PendingPrompts.js';
import { InterruptNotice } from './components/InterruptNotice.js';
import { StopButton } from './components/StopButton.js';
import { PromptInput } from './components/PromptInput.js';
import { deriveAgentStatus } from './agentStatus.js';
import { Avatar } from './components/Avatar.js';
import { DriverRequestNotice } from './components/DriverRequestNotice.js';
import { ShortcutCheatsheet } from './components/ShortcutCheatsheet.js';
import { RoomSwitcher } from './components/RoomSwitcher.js';
import type { RecentRoom } from './rooms.js';
import { forgetAllRooms, forgetRoom, readRecentRooms, rememberRoom } from './rooms.js';
import { NoticeStack } from './components/NoticeStack.js';
import type { StackedNotice } from './components/NoticeStack.js';
import { ReKeyDialog } from './components/Notice.js';

function readParams(): { roomId: string; token: string; displayName: string } {
  const params = new URLSearchParams(globalThis.location.search);
  return {
    roomId: params.get('room') ?? '',
    token: params.get('token') ?? '',
    displayName: params.get('name') ?? 'anonymous',
  };
}

/**
 * Derives a human room label the same way RoomHeader documents: the repo
 * name from `room_created` if one is known, else a short room id. Never the
 * token (I4).
 */
function deriveRoomLabel(events: NexusEvent[], roomId: string): string {
  const created = events.find((event): event is Extract<NexusEvent, { type: 'room_created' }> =>
    event.type === 'room_created',
  );
  if (created !== undefined && created.repoUrl !== null) {
    const match = created.repoUrl.match(/([^/]+?)(?:\.git)?\/?$/);
    if (match?.[1]) return match[1];
  }
  return roomId.slice(0, 8);
}

/**
 * A thin wrapper around the real WebSocket that mirrors every close event's
 * code out to `onCloseCode` before handing it to whatever `ws.ts` assigns as
 * `onclose`. `ws.ts` (not owned by this integration pass) collapses both 4401
 * and 4409 to the single `'closed'` status, which is enough to drive
 * reconnection but not enough to tell "invalid link" apart from "needs a new
 * API key" for the recovery UI below. This stays entirely inside App.tsx via
 * the existing `socketFactory` extension point, so `ws.ts` itself is untouched.
 */
class CloseCodeTrackingSocket implements WebSocketLike {
  private readonly real: WebSocket;
  private closeHandler: ((event?: { code?: number }) => void) | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(url: string, onCloseCode: (code: number | undefined) => void) {
    this.real = new WebSocket(url);
    this.real.onopen = () => this.onopen?.();
    this.real.onmessage = (event) => this.onmessage?.({ data: event.data });
    this.real.onclose = (event) => {
      onCloseCode(event.code);
      this.closeHandler?.(event);
    };
  }

  get onclose(): ((event?: { code?: number }) => void) | null {
    return this.closeHandler;
  }

  set onclose(handler: ((event?: { code?: number }) => void) | null) {
    this.closeHandler = handler;
  }

  send(data: string): void {
    this.real.send(data);
  }

  close(): void {
    this.real.close();
  }
}

/**
 * Wraps a single pending approval so `a`/`d` can decide it — but scoped to
 * this card alone (`useHotkeys`'s `scopeRef`), never registered on
 * `document`. A global `d` would let someone deny (or `a` approve) a
 * destructive tool call by typing a word while focus sat on the page body;
 * scoping to the card's own container means the keys only reach this
 * handler while the card, or something inside it, holds focus.
 */
function ApprovalCard({
  approval,
  now,
  onDecide,
}: {
  approval: PendingApproval;
  now: number;
  onDecide: (requestId: string, decision: 'allow' | 'deny', reason?: string) => void;
}): JSX.Element {
  const cardRef = useRef<HTMLDivElement | null>(null);
  useHotkeys(
    [
      {
        combo: 'a',
        handler: () => onDecide(approval.requestId, 'allow'),
        description: 'Approve the focused request',
      },
      {
        combo: 'd',
        handler: () => onDecide(approval.requestId, 'deny'),
        description: 'Deny the focused request',
      },
    ],
    cardRef,
  );
  return (
    <div ref={cardRef}>
      <ApprovalPrompt approval={approval} now={now} onDecide={onDecide} />
    </div>
  );
}

/** A minimal participant picker for `⌘⇧G` — grant control without opening the roster. */
function GrantControlPicker({
  open,
  participants,
  selfId,
  onGrant,
  onClose,
}: {
  open: boolean;
  participants: RoomView['participants'];
  selfId: string | null;
  onGrant: (participantId: string) => void;
  onClose: () => void;
}): JSX.Element | null {
  if (!open) return null;
  const candidates = participants.filter((p) => p.participantId !== selfId && p.connected);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Grant control"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        className="w-full max-w-sm rounded-lg border border-border bg-surface p-4 shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
      >
        <h2 className="mb-2 text-sm font-semibold text-fg">Grant control to…</h2>
        {candidates.length === 0 ? (
          <p className="text-sm text-fg-muted">No one else is here yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {candidates.map((p) => (
              <li key={p.participantId}>
                <button
                  type="button"
                  onClick={() => {
                    onGrant(p.participantId);
                    onClose();
                  }}
                  className="flex min-h-11 w-full items-center gap-2 rounded px-2 text-left text-sm text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                >
                  <Avatar participantId={p.participantId} displayName={p.displayName} size="sm" />
                  {p.displayName}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function App(): JSX.Element {
  const params = useMemo(readParams, []);
  const [view, setView] = useState<RoomView>(EMPTY_VIEW);
  const [status, setStatus] = useState<Status>('connecting');
  const [connection, setConnection] = useState<Connection | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // phase-3d: dismiss by count, not message text — "You are not driving" is
  // the most common error and a non-driver hits it repeatedly, so comparing
  // text alone would swallow every repeat after the first dismissal.
  const [dismissedCount, setDismissedCount] = useState(0);
  const bannerMessage = view.errorCount > dismissedCount ? view.lastError : null;

  const [lastCloseCode, setLastCloseCode] = useState<number | undefined>(undefined);
  const [reKeyOpen, setReKeyOpen] = useState(false);

  useEffect(() => {
    if (params.roomId === '' || params.token === '') return undefined;
    const active = connect({
      ...params,
      onView: setView,
      onStatus: setStatus,
      socketFactory: (url) => new CloseCodeTrackingSocket(url, setLastCloseCode),
    });
    setConnection(active);
    return () => active.close();
  }, [params]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // --- BEGIN phase-3c landing-page slot: replace this branch with <CreateRoom/>. ---
  // --- END phase-3c landing-page slot ---
  // Under the phase-5a router, "/" with no room/token is now the marketing
  // landing page — Router never mounts <App/> for that case. If App IS
  // reached without both halves of a link, that link is genuinely broken.
  if (params.roomId === '' || params.token === '') {
    return <MalformedLink />;
  }

  // --- BEGIN phase-5b layout ---
  const iAmDriving = view.driverId !== null && view.driverId === view.selfId;
  const roomLabel = deriveRoomLabel(view.events, params.roomId);
  const roomLink = `${globalThis.location.origin}/?room=${params.roomId}&token=${params.token}&name=${encodeURIComponent(params.displayName)}`;
  const agentStatus = deriveAgentStatus(view.events, view.pendingDeltas);
  const { pending: pendingApprovals } = deriveApprovals(view.events);
  const pendingPromptCount = derivePending(view.events).filter((p) => p.status === 'queued').length;
  const railBadgeCount = pendingApprovals.length + pendingPromptCount;

  return (
    <RoomShell
      params={params}
      view={view}
      status={status}
      connection={connection}
      now={now}
      bannerMessage={bannerMessage}
      setDismissedCount={setDismissedCount}
      lastCloseCode={lastCloseCode}
      reKeyOpen={reKeyOpen}
      setReKeyOpen={setReKeyOpen}
      iAmDriving={iAmDriving}
      roomLabel={roomLabel}
      roomLink={roomLink}
      agentStatus={agentStatus}
      pendingApprovals={pendingApprovals}
      railBadgeCount={railBadgeCount}
    />
  );
  // --- END phase-5b layout ---
}

/**
 * The connected room's shell — split from `App` only so hooks that must run
 * unconditionally (every hook below) never sit behind the malformed-link
 * early return above. All state here is genuinely local UI state (palette
 * open, rail open, dismissed requests) or derived straight from `view.events`
 * (I3) — nothing mirrors server state into a parallel store.
 */
function RoomShell({
  params,
  view,
  status,
  connection,
  now,
  bannerMessage,
  setDismissedCount,
  lastCloseCode,
  reKeyOpen,
  setReKeyOpen,
  iAmDriving,
  roomLabel,
  roomLink,
  agentStatus,
  pendingApprovals,
  railBadgeCount,
}: {
  params: { roomId: string; token: string; displayName: string };
  view: RoomView;
  status: Status;
  connection: Connection | null;
  now: number;
  bannerMessage: string | null;
  setDismissedCount: (count: number) => void;
  lastCloseCode: number | undefined;
  reKeyOpen: boolean;
  setReKeyOpen: (open: boolean) => void;
  iAmDriving: boolean;
  roomLabel: string;
  roomLink: string;
  agentStatus: ReturnType<typeof deriveAgentStatus>;
  pendingApprovals: PendingApproval[];
  railBadgeCount: number;
}): JSX.Element {
  const [promptText, setPromptText] = useState('');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [grantPickerOpen, setGrantPickerOpen] = useState(false);
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  const [interruptArmed, setInterruptArmed] = useState(false);
  const [dismissedDriverRequests, setDismissedDriverRequests] = useState<Set<string>>(new Set());
  const [recentRooms, setRecentRooms] = useState<RecentRoom[]>(() => readRecentRooms());
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persist this room in the local switcher's history once the server has
  // confirmed our identity — never before, so an unreachable or rejected
  // room never pollutes "recent rooms" with a token that was never valid.
  useEffect(() => {
    if (view.selfId === null) return;
    rememberRoom({
      roomId: params.roomId,
      token: params.token,
      displayName: params.displayName,
      label: roomLabel,
      lastSeenAt: Date.now(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.selfId, params.roomId]);

  useEffect(() => {
    if (switcherOpen) setRecentRooms(readRecentRooms());
  }, [switcherOpen]);

  useEffect(() => {
    return () => {
      if (armTimerRef.current !== null) clearTimeout(armTimerRef.current);
    };
  }, []);

  function submitPrompt(): void {
    const trimmed = promptText.trim();
    if (trimmed === '') return;
    connection?.send({ kind: 'prompt', text: trimmed });
    setPromptText('');
  }

  function toggleDriver(): void {
    connection?.send({ kind: iAmDriving ? 'release_control' : 'request_control' });
  }

  function handleInterruptHotkey(): void {
    if (interruptArmed) {
      connection?.send({ kind: 'interrupt' });
      setInterruptArmed(false);
      if (armTimerRef.current !== null) clearTimeout(armTimerRef.current);
      return;
    }
    setInterruptArmed(true);
    armTimerRef.current = setTimeout(() => setInterruptArmed(false), 3000);
  }

  function navigateToRoom(room: RecentRoom): void {
    globalThis.location.assign(
      `/?room=${room.roomId}&token=${room.token}&name=${encodeURIComponent(room.displayName)}`,
    );
  }

  const hotkeys: Hotkey[] = [
    { combo: 'mod+k', handler: () => setSwitcherOpen(true), allowInInput: true, description: 'Switch room' },
    { combo: 'mod+shift+d', handler: toggleDriver, allowInInput: true, description: 'Request or release control' },
    { combo: 'mod+shift+g', handler: () => setGrantPickerOpen(true), allowInInput: true, description: 'Grant control' },
    { combo: 'mod+enter', handler: submitPrompt, allowInInput: true, description: 'Send prompt' },
    { combo: 'escape', handler: handleInterruptHotkey, allowInInput: true, description: 'Interrupt the agent (press twice)' },
    { combo: '?', handler: () => setCheatsheetOpen(true), description: 'Show keyboard shortcuts' },
  ];
  useHotkeys(hotkeys);

  const notices: StackedNotice[] = [];
  if (status === 'closed' && lastCloseCode === 4409) {
    notices.push({
      id: 'closed-4409',
      severity: 'fatal',
      message: 'This room lost its API key when the server restarted.',
      action: { label: 'Re-enter API key', onAct: () => setReKeyOpen(true) },
    });
  } else if (status === 'closed' && lastCloseCode === 4401) {
    notices.push({
      id: 'closed-4401',
      severity: 'fatal',
      message: 'This room link is invalid or has been revoked.',
      action: { label: 'Get a new room', onAct: () => globalThis.location.assign('/new') },
    });
  }
  if (interruptArmed) {
    notices.push({
      id: 'interrupt-armed',
      severity: 'warn',
      message: 'Press Escape again to stop the agent.',
    });
  }

  return (
    <div className="flex h-screen flex-col bg-bg">
      <NoticeStack notices={notices} />

      <RoomHeader
        roomLabel={roomLabel}
        roomLink={roomLink}
        participants={view.participants}
        driverId={view.driverId}
        selfId={view.selfId}
        agentStatus={agentStatus}
        now={now}
        onRequestControl={() => connection?.send({ kind: 'request_control' })}
        onReleaseControl={() => connection?.send({ kind: 'release_control' })}
        onGrantControl={(toParticipantId) => connection?.send({ kind: 'grant_control', toParticipantId })}
        onOpenSwitcher={() => setSwitcherOpen(true)}
        onOpenCheatsheet={() => setCheatsheetOpen(true)}
      />

      <div className="flex min-h-0 flex-1">
        <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
          <div className="flex justify-end">
            <ConnectionStatus status={status} />
          </div>

          {/* --- BEGIN phase-3d error banner slot: render <ErrorBanner/> here. --- */}
          <ErrorBanner message={bannerMessage} onDismiss={() => setDismissedCount(view.errorCount)} />
          {/* --- END phase-3d error banner slot --- */}

          <DriverRequestNotice
            events={view.events}
            selfId={view.selfId}
            driverId={view.driverId}
            onGrant={(participantId) => connection?.send({ kind: 'grant_control', toParticipantId: participantId })}
            onDismiss={(participantId) =>
              setDismissedDriverRequests((current) => new Set(current).add(participantId))
            }
            dismissedParticipantIds={dismissedDriverRequests}
          />

          {/* --- BEGIN phase-2d approval slot --- */}
          {/* A blocked room is the most urgent fact on the screen — these stay
              above the transcript in the main column, in addition to the
              pending count shown in the side rail. */}
          {pendingApprovals.map((approval) => (
            <ApprovalCard
              key={approval.requestId}
              approval={approval}
              now={now}
              onDecide={(requestId, decision, reason) =>
                connection?.send(
                  reason === undefined
                    ? { kind: 'permission_decision', requestId, decision }
                    : { kind: 'permission_decision', requestId, decision, reason },
                )
              }
            />
          ))}
          {/* --- END phase-2d approval slot --- */}

          <div className="min-h-0 flex-1">
            <MessageList events={view.events} pendingDeltas={view.pendingDeltas} />
          </div>

          {/*
            The input is gated on connection state only, never on the driver token —
            that is the point of I2'. Anyone may speak; the server orders, attributes
            and batches, and the agent resolves genuine conflicts in the driver's
            favour. Adding a driver check here would undo the feature.
          */}
          {/* --- BEGIN phase-3b stop-button slot: wrap in a flex row, add <StopButton/> beside it. --- */}
          <InterruptNotice events={view.events} />
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <PromptInput
                disabled={status !== 'open'}
                value={promptText}
                onChange={setPromptText}
                onSubmit={(text) => {
                  connection?.send({ kind: 'prompt', text });
                  setPromptText('');
                }}
              />
            </div>
            <StopButton busy={false} onStop={() => connection?.send({ kind: 'interrupt' })} />
          </div>
          {/* --- END phase-3b stop-button slot --- */}
        </main>

        <div className="hidden lg:flex">
          <SideRail
            participants={view.participants}
            driverId={view.driverId}
            selfId={view.selfId}
            events={view.events}
            onRequestControl={() => connection?.send({ kind: 'request_control' })}
            onReleaseControl={() => connection?.send({ kind: 'release_control' })}
            onGrantControl={(toParticipantId) => connection?.send({ kind: 'grant_control', toParticipantId })}
            onResendPrompt={(text) => connection?.send({ kind: 'prompt', text })}
          />
        </div>
      </div>

      {/* Below `lg` the rail collapses to a bottom sheet with a badge count. */}
      <div className="lg:hidden">
        <button
          type="button"
          onClick={() => setMobileRailOpen((open) => !open)}
          aria-expanded={mobileRailOpen}
          aria-controls="mobile-rail-sheet"
          className="fixed bottom-20 right-4 z-20 flex min-h-11 items-center gap-2 rounded-full border border-border bg-surface-2 px-4 py-2 text-sm font-medium text-fg shadow-[0_8px_24px_rgba(0,0,0,0.4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          Room details
          {railBadgeCount > 0 && (
            <span className="rounded-full bg-warn px-1.5 py-0.5 text-[10px] font-semibold text-bg">
              {railBadgeCount}
            </span>
          )}
        </button>
        {mobileRailOpen && (
          <div
            id="mobile-rail-sheet"
            className="fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-auto rounded-t-xl border-t border-border bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
          >
            <SideRail
              participants={view.participants}
              driverId={view.driverId}
              selfId={view.selfId}
              events={view.events}
              onRequestControl={() => connection?.send({ kind: 'request_control' })}
              onReleaseControl={() => connection?.send({ kind: 'release_control' })}
              onGrantControl={(toParticipantId) => connection?.send({ kind: 'grant_control', toParticipantId })}
              onResendPrompt={(text) => connection?.send({ kind: 'prompt', text })}
            />
          </div>
        )}
      </div>

      <GrantControlPicker
        open={grantPickerOpen}
        participants={view.participants}
        selfId={view.selfId}
        onGrant={(participantId) => connection?.send({ kind: 'grant_control', toParticipantId: participantId })}
        onClose={() => setGrantPickerOpen(false)}
      />

      <ShortcutCheatsheet
        open={cheatsheetOpen}
        onClose={() => setCheatsheetOpen(false)}
        shortcuts={hotkeys}
      />

      <RoomSwitcher
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
        rooms={recentRooms}
        currentRoomId={params.roomId}
        onNavigate={navigateToRoom}
        onForget={(roomId) => {
          forgetRoom(roomId);
          setRecentRooms(readRecentRooms());
        }}
        onForgetAll={() => {
          forgetAllRooms();
          setRecentRooms([]);
        }}
      />

      {reKeyOpen && (
        <ReKeyDialog
          roomId={params.roomId}
          token={params.token}
          onSubmitted={() => {
            setReKeyOpen(false);
            globalThis.location.reload();
          }}
          onCancel={() => setReKeyOpen(false)}
        />
      )}
    </div>
  );
}
