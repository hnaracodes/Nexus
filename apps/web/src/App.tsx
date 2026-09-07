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
import type { AgentId, NexusEvent } from '@nexus/protocol/events';
import { PRIMARY_AGENT_ID, agentIdOf } from '@nexus/protocol/events';
// phase-5a import anchor
import { MalformedLink } from './pages/MalformedLink.js';
// phase-7b import anchor
import { WorkspacePane } from './components/WorkspacePane.js';
import { FleetPane } from './components/FleetPane.js';
import { ApprovalQueue } from './components/ApprovalQueue.js';
import type { FleetApprovalRequest } from './components/ApprovalQueue.js';
import { PaneErrorBoundary } from './components/PaneErrorBoundary.js';
import { createWorkspaceApi } from './workspace/workspaceApi.js';
import type { DocSession } from './workspace/docSession.js';
// phase-7c import anchor
import { PromptDock } from './components/PromptDock.js';
import { JoinGate, readStoredName, storeName } from './components/JoinGate.js';
import { JoinToasts } from './components/JoinToasts.js';
// phase-5b import anchor
import { useHotkeys } from './hooks/useHotkeys.js';
import type { Hotkey } from './hooks/useHotkeys.js';
import { RoomHeader } from './components/RoomHeader.js';
import { deriveGithubBinding } from './githubBinding.js';
import { PublishedPrCard } from './components/PublishedPr.js';
import { deriveLatestPublishedPr } from './publishedPr.js';
import { MessageList } from './components/MessageList.js';
import { PendingPrompts } from './components/PendingPrompts.js';
import { InterruptNotice } from './components/InterruptNotice.js';
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
    // No default. "anonymous" used to be filled in here, which meant a room
    // with three unnamed people showed three identical roster rows and every
    // prompt in the transcript was attributed to nobody — in a product built
    // on attributed collaboration, that defeats the feature. An empty name now
    // routes to <JoinGate/> instead.
    displayName: params.get('name') ?? '',
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
  const linkParams = useMemo(readParams, []);
  // A name from the link wins; otherwise one this browser already chose for
  // this room; otherwise nothing, and the gate asks. Persisting matters beyond
  // convenience — ws.ts keys stored identity on (roomId, displayName), so a
  // name that changed on every reload would orphan the participant id and the
  // driver token with it.
  const [chosenName, setChosenName] = useState<string | null>(
    () => (linkParams.displayName !== '' ? linkParams.displayName : readStoredName(linkParams.roomId)),
  );
  const params = useMemo(
    () => ({ ...linkParams, displayName: chosenName ?? '' }),
    [linkParams, chosenName],
  );
  const [view, setView] = useState<RoomView>(EMPTY_VIEW);
  const [status, setStatus] = useState<Status>('connecting');
  const [connection, setConnection] = useState<Connection | null>(null);
  /**
   * The room's collaborative document session, handed over by `connect()` once
   * `replay_complete` supplies this client's own participant id (a session
   * needs it to recognise its own edits echoed back).
   *
   * Held in state rather than a ref because the file pane must RE-RENDER when
   * it arrives — a ref would leave the editor mounted read-only for the rest
   * of the session, which is indistinguishable from the feature not shipping.
   */
  const [docSession, setDocSession] = useState<DocSession | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // phase-3d: dismiss by count, not message text — "You are not driving" is
  // the most common error and a non-driver hits it repeatedly, so comparing
  // text alone would swallow every repeat after the first dismissal.
  const [dismissedCount, setDismissedCount] = useState(0);
  const bannerMessage = view.errorCount > dismissedCount ? view.lastError : null;

  const [lastCloseCode, setLastCloseCode] = useState<number | undefined>(undefined);
  const [reKeyOpen, setReKeyOpen] = useState(false);

  useEffect(() => {
    // Nothing connects until there is a name. Joining and then renaming would
    // mean a participant_joined already sat in the durable log under the wrong
    // identity, and I3 forbids rewriting it.
    if (params.roomId === '' || params.token === '' || params.displayName === '') return undefined;
    const active = connect({
      ...params,
      onView: setView,
      onStatus: setStatus,
      onDocSession: setDocSession,
      socketFactory: (url) => new CloseCodeTrackingSocket(url, setLastCloseCode),
    });
    setConnection(active);
    return () => {
      active.close();
      // Cleared with the connection that owned it. `connect()` builds exactly
      // one session per call and disposes it on close, so keeping the old
      // reference across a room switch would hand the editor a session whose
      // socket is gone — writable in appearance, inert in fact.
      setDocSession(null);
    };
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
  if (linkParams.roomId === '' || linkParams.token === '') {
    return <MalformedLink />;
  }

  if (chosenName === null) {
    return (
      <JoinGate
        roomLabel={deriveRoomLabel([], linkParams.roomId)}
        onJoin={(name) => {
          storeName(linkParams.roomId, name);
          setChosenName(name);
        }}
      />
    );
  }

  // --- BEGIN phase-5b layout ---
  const iAmDriving = view.driverId !== null && view.driverId === view.selfId;
  const roomLabel = deriveRoomLabel(view.events, params.roomId);
  const roomLink = `${globalThis.location.origin}/?room=${params.roomId}&token=${params.token}&name=${encodeURIComponent(params.displayName)}`;
  const agentStatus = deriveAgentStatus(view.events, view.pendingDeltas);
  const { pending: pendingApprovals } = deriveApprovals(view.events);

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
      docSession={docSession}
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
  docSession,
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
  /** The room's collaborative document session, or null before
   *  `replay_complete` has arrived. Null keeps the file pane read-only. */
  docSession: DocSession | null;
}): JSX.Element {
  /**
   * Which agent's transcript is on screen. LOCAL UI state, like the workspace
   * pane's pin/follow — no room state, no arbitration, no server round trip.
   * `null` means the primary agent, which is what a solo room always shows.
   */
  const [focusedAgentId, setFocusedAgentId] = useState<AgentId | null>(null);
  const [promptText, setPromptText] = useState('');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [grantPickerOpen, setGrantPickerOpen] = useState(false);
  const [mobileWorkspaceOpen, setMobileWorkspaceOpen] = useState(false);
  const [interruptArmed, setInterruptArmed] = useState(false);
  const [dismissedDriverRequests, setDismissedDriverRequests] = useState<Set<string>>(new Set());
  const [recentRooms, setRecentRooms] = useState<RecentRoom[]>(() => readRecentRooms());
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Deliberately NOT in `store.ts` and NOT on RoomView (I3). File contents are
  // read from the room's working directory and are not reconstructible from the
  // event log, so they are fetched over REST and cached inside useWorkspace.
  // This is the one piece of room-visible state in the app that is not
  // log-derived, and drawing that boundary explicitly is the point.
  /**
   * The room's pending approvals, re-shaped per agent for the fleet queue.
   *
   * Derived here rather than by widening `deriveApprovals`, because the
   * single-agent card path below still consumes that function's existing
   * shape and a solo room must keep rendering byte-identically. `expiresAt` is
   * carried through as-is: a request the server has not yet SURFACED has no
   * clock running (phase 12, D3), and the queue must not draw a countdown for
   * something that is not counting down.
   */
  const fleetApprovals = useMemo<FleetApprovalRequest[]>(() => {
    const settled = new Set(
      view.events.filter((e) => e.type === 'permission_decided').map((e) => e.requestId),
    );
    const nameOf = new Map(view.fleet.map((entry) => [entry.agentId, entry.displayName]));
    return view.events
      .filter((e): e is Extract<NexusEvent, { type: 'permission_requested' }> =>
        e.type === 'permission_requested' && !settled.has(e.requestId))
      .map((e) => {
        const agentId = agentIdOf(e);
        return {
          requestId: e.requestId,
          agentId,
          agentName: nameOf.get(agentId) ?? (agentId === PRIMARY_AGENT_ID ? 'Agent' : agentId),
          toolName: e.toolName,
          input: e.input,
          expiresAt: e.expiresAt,
        };
      });
  }, [view.events, view.fleet]);

  /**
   * The events the transcript shows. Unfiltered unless a fleet exists AND a
   * specific agent is focused — a solo room, and a fleet room with nothing
   * focused, both render exactly what they always did.
   *
   * Filtering by `agentIdOf` also drops room-level events (joins, driver
   * hand-offs) from a non-primary agent's view, which is deliberate: you asked
   * to look at one agent's work, and the primary transcript still holds the
   * room's own history.
   */
  const focusedEvents = useMemo(
    () =>
      focusedAgentId === null
        ? view.events
        : view.events.filter(
            // Cast for the same reason `replay.ts` does it server-side:
            // `agentIdOf` reads an optional field that only the agent-scoped
            // members of the union declare, and a room-level event simply
            // reads as the primary agent — which is exactly the v1 convention
            // this helper exists to centralise.
            (event) => agentIdOf(event as { agentId?: AgentId }) === focusedAgentId,
          ),
    [view.events, focusedAgentId],
  );

  /** A solo room must not grow a sidebar it does not need. */
  const hasFleet = view.fleet.length > 1;

  const workspaceApi = useMemo(
    () => createWorkspaceApi({ roomId: params.roomId, token: params.token }),
    [params.roomId, params.token],
  );

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
        github={deriveGithubBinding(view.events)}
        onRequestControl={() => connection?.send({ kind: 'request_control' })}
        onReleaseControl={() => connection?.send({ kind: 'release_control' })}
        onGrantControl={(toParticipantId) => connection?.send({ kind: 'grant_control', toParticipantId })}
        onOpenSwitcher={() => setSwitcherOpen(true)}
        onOpenCheatsheet={() => setCheatsheetOpen(true)}
      />

      {/* --- BEGIN phase-7 workspace slot --- */}
      {/* Chat column + workspace pane. The chat column is a fixed proportion so
          the code viewer gets the majority of a wide screen; below `lg` the
          workspace does not render here at all and moves to the full-screen
          sheet below. */}
      <div className="flex min-h-0 flex-1">
        <main className="flex min-h-0 w-full flex-col gap-3 overflow-hidden p-4 lg:w-[44%] lg:min-w-[380px] lg:max-w-[680px] lg:shrink-0 lg:border-r lg:border-border">
          <div className="flex justify-end">
            <ConnectionStatus status={status} />
          </div>

          {/* --- BEGIN phase-3d error banner slot: render <ErrorBanner/> here. --- */}
          <ErrorBanner message={bannerMessage} onDismiss={() => setDismissedCount(view.errorCount)} />
          {/* --- END phase-3d error banner slot --- */}

          <PublishedPrCard
            pr={deriveLatestPublishedPr(view.events)}
            selfId={view.selfId}
            replaying={view.replaying}
          />

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
          {hasFleet && (
            <ApprovalQueue
              requests={fleetApprovals}
              now={now}
              onDecide={(requestId, agentId, decision, reason) =>
                connection?.send({
                  kind: 'permission_decision',
                  requestId,
                  decision,
                  agentId,
                  ...(reason === undefined ? {} : { reason }),
                })
              }
            />
          )}
          {!hasFleet && pendingApprovals.map((approval) => (
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

          {hasFleet && (
            <FleetPane
              agents={view.fleet}
              focusedAgentId={focusedAgentId}
              onFocus={setFocusedAgentId}
              onSpawn={(params) => connection?.send({ kind: 'spawn_agent', ...params })}
              onStop={(agentId) => connection?.send({ kind: 'stop_agent', agentId })}
            />
          )}

          <div className="min-h-0 flex-1">
            <MessageList events={focusedEvents} pendingDeltas={view.pendingDeltas} />
          </div>

          {/*
            The input is gated on connection state only, never on the driver token —
            that is the point of I2'. Anyone may speak; the server orders, attributes
            and batches, and the agent resolves genuine conflicts in the driver's
            favour. Adding a driver check here would undo the feature.
          */}
          {/* --- BEGIN phase-7 prompt dock --- */}
          {/* --- BEGIN phase-3b stop-button slot --- */}
          <InterruptNotice events={view.events} />
          {/* Rehomed from the retired SideRail. This is about what is ABOUT to
              be sent, so it belongs next to the input rather than off in a rail. */}
          <PendingPrompts
            events={view.events}
            onResend={(text) => connection?.send({ kind: 'prompt', text })}
          />
          <PromptDock
            roomId={params.roomId}
            token={params.token}
            events={view.events}
            driverId={view.driverId}
            selfId={view.selfId}
            promptDisabled={status !== 'open'}
            promptValue={promptText}
            onPromptChange={setPromptText}
            onSubmitPrompt={(text) => {
              connection?.send({ kind: 'prompt', text });
              setPromptText('');
            }}
            onStop={() => connection?.send({ kind: 'interrupt' })}
            stopBusy={false}
            onSetModel={(model) => connection?.send({ kind: 'set_model', model })}
          />
          {/* --- END phase-3b stop-button slot --- */}
          {/* --- END phase-7 prompt dock --- */}
        </main>

        <div className="hidden min-h-0 flex-1 lg:flex">
          <PaneErrorBoundary label="The workspace panel">
                <WorkspacePane
                  events={view.events}
                  api={workspaceApi}
                  externalChanges={view.externalChanges}
                  {...(docSession === null ? {} : { docSession })}
                  selfId={view.selfId}
                />
              </PaneErrorBoundary>
        </div>
      </div>
      {/* --- END phase-7 workspace slot --- */}

      {/* --- BEGIN phase-7 mobile workspace sheet --- */}
      {/* Below `lg` the workspace column does not render, so it gets a sheet.
          FULL-SCREEN (`inset-0`), not the 70vh the retired room-details sheet
          used — a code viewer in 70vh is unusable. The old railBadgeCount
          retired with SideRail: pending approvals already render in the main
          column and pending prompts now sit above the prompt input, so the
          badge was counting things that are no longer hidden. */}
      <div className="lg:hidden">
        <button
          type="button"
          onClick={() => setMobileWorkspaceOpen((open) => !open)}
          aria-expanded={mobileWorkspaceOpen}
          aria-controls="mobile-workspace-sheet"
          className="fixed bottom-20 right-4 z-20 flex min-h-11 items-center gap-2 rounded-full border border-border bg-surface-2 px-4 py-2 text-sm font-medium text-fg shadow-[0_8px_24px_rgba(0,0,0,0.4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          Workspace
        </button>
        {mobileWorkspaceOpen && (
          <div
            id="mobile-workspace-sheet"
            className="fixed inset-0 z-40 flex flex-col bg-surface"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <span className="text-sm font-medium text-fg">Workspace</span>
              <button
                type="button"
                onClick={() => setMobileWorkspaceOpen(false)}
                className="min-h-11 rounded px-3 text-sm text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                Close
              </button>
            </div>
            <div className="flex min-h-0 flex-1">
              <PaneErrorBoundary label="The workspace panel">
                <WorkspacePane
                  events={view.events}
                  api={workspaceApi}
                  externalChanges={view.externalChanges}
                  {...(docSession === null ? {} : { docSession })}
                  selfId={view.selfId}
                />
              </PaneErrorBoundary>
            </div>
          </div>
        )}
      </div>
      {/* --- END phase-7 mobile workspace sheet --- */}

      <JoinToasts events={view.events} selfId={view.selfId} />

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
