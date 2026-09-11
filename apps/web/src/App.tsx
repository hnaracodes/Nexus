import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderTree, GitCompare, ShieldAlert, Users } from 'lucide-react';
import { deriveApprovals } from './approvals.js';
import type { PendingApproval } from './approvals.js';
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
import { FleetPane } from './components/FleetPane.js';
import { Button } from './components/Button.js';
import { Canvas } from './canvas/Canvas.js';
import { RunOverlay } from './canvas/RunOverlay.js';
import type { Graph } from './canvas/graph.js';
import type { FleetApprovalRequest } from './components/ApprovalQueue.js';
import { PaneErrorBoundary } from './components/PaneErrorBoundary.js';
import { createWorkspaceApi } from './workspace/workspaceApi.js';
import type { DocSession } from './workspace/docSession.js';
import { useWorkspace } from './workspace/useWorkspace.js';
import { WorkspaceError } from './workspace/types.js';
import type { GitStatusEntry } from './workspace/types.js';
import { deriveCurrentFile, deriveLatestEditSeqByPath, deriveTouchedFiles } from './derive/workspaceFiles.js';
import { withExternalChanges } from './derive/externalChanges.js';
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
// phase-17a import anchor — the VS Code-shaped shell
import { ActivityBar } from './components/ActivityBar.js';
import type { ActivityBarItem, SideBarView } from './components/ActivityBar.js';
import { SideBar } from './components/SideBar.js';
import { TabStrip, isTabDirty } from './components/TabStrip.js';
import type { OpenTab } from './components/TabStrip.js';
import { Panel } from './components/Panel.js';
import { StatusBar } from './components/StatusBar.js';
import { CodeEditor } from './components/CodeEditor.js';
import type { GitStatusState } from './components/ChangesTab.js';
import { LAYOUT } from './design/tokens.js';

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

/**
 * `⌘P` quick-open: types a substring, picks a file, it opens as a tab. There
 * is no existing "list every file in the tree" endpoint (`WorkspaceApi.getTree`
 * is one directory at a time, matching `FileTree`'s own lazy expansion), so
 * this walks the tree itself once per open — capped in both directions
 * (`MAX_RESULTS` files, `MAX_DEPTH` levels) so a huge or unusually deep repo
 * cannot turn one keypress into an unbounded fetch storm.
 */
const QUICK_OPEN_MAX_RESULTS = 500;
const QUICK_OPEN_MAX_DEPTH = 8;

function QuickOpenDialog({
  open,
  api,
  onOpen,
  onClose,
}: {
  open: boolean;
  api: ReturnType<typeof createWorkspaceApi>;
  onOpen: (path: string) => void;
  onClose: () => void;
}): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [allFiles, setAllFiles] = useState<string[] | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setAllFiles(null);
      return undefined;
    }
    let cancelled = false;
    const found: string[] = [];

    async function walk(path: string, depth: number): Promise<void> {
      if (cancelled || found.length >= QUICK_OPEN_MAX_RESULTS || depth > QUICK_OPEN_MAX_DEPTH) return;
      const entries = await api.getTree(path).catch(() => []);
      for (const entry of entries) {
        if (cancelled || found.length >= QUICK_OPEN_MAX_RESULTS) return;
        if (entry.type === 'file') {
          found.push(entry.path);
        } else {
          await walk(entry.path, depth + 1);
        }
      }
    }

    void walk('', 0).then(() => {
      if (!cancelled) setAllFiles(found);
    });
    const focusId = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(focusId);
    };
  }, [open, api]);

  if (!open) return null;

  const matches =
    allFiles === null
      ? []
      : allFiles.filter((path) => path.toLowerCase().includes(query.toLowerCase())).slice(0, 50);

  function pick(path: string): void {
    onOpen(path);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-bg/70 p-4 pt-24" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Go to file"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === 'Enter' && matches[0] !== undefined) {
            event.preventDefault();
            pick(matches[0]);
          }
        }}
        className="w-full max-w-lg rounded-lg border border-border bg-surface p-2 shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Go to file…"
          aria-label="Go to file"
          className="min-h-11 w-full rounded border border-border-strong bg-bg px-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <ul className="mt-2 max-h-72 overflow-y-auto">
          {allFiles === null && <li className="p-2 text-xs text-fg-muted">Loading files…</li>}
          {allFiles !== null && matches.length === 0 && (
            <li className="p-2 text-xs text-fg-muted">No matching files.</li>
          )}
          {matches.map((path) => (
            <li key={path}>
              <button
                type="button"
                onClick={() => pick(path)}
                className="flex min-h-9 w-full items-center rounded px-2 text-left font-mono text-xs text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {path}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Which tab is active after closing one — the whole of `closeTab`'s logic,
 * pulled out as a pure function so it can actually be tested.
 *
 * It was inline in the component, which meant the only coverage was a
 * two-tab "close one, the other stays" case — and with two tabs, "prefer the
 * left neighbour" and "prefer the right neighbour" give the same answer, so
 * that test could not tell the two rules apart. The comment claimed left; the
 * arithmetic does right. A reviewer caught it by tracing the expression by
 * hand, which is exactly the work a test is supposed to save someone.
 *
 * The rule, stated honestly: `Math.min(idx, paths.length - 1)` reads the index
 * the closed tab occupied out of the ALREADY-SHORTENED array, so it lands on
 * the tab that was to the closed one's RIGHT, and falls back to the left only
 * when the closed tab was the last one. That is what every editor does.
 */
export function closeTabState(
  current: { paths: string[]; active: string | null },
  path: string,
): { paths: string[]; active: string | null } {
  const idx = current.paths.indexOf(path);
  if (idx === -1) return current;
  const paths = current.paths.filter((p) => p !== path);
  // Closing a background tab never moves focus.
  if (current.active !== path) return { paths, active: current.active };
  const active = paths.length === 0 ? null : (paths[Math.min(idx, paths.length - 1)] ?? null);
  return { paths, active };
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
  /**
   * The workflow graph on screen, if any.
   *
   * The canvas lives INSIDE the room rather than on its own page, and that is
   * the phase-14 claim made structural: it is a VIEW over the orchestration
   * model, so it renders where the model actually is. A standalone page would
   * have had no live `fleet` frame and could only ever have drawn a graph that
   * was not running — which is a diagram, not a canvas.
   */
  const [canvasGraph, setCanvasGraph] = useState<Graph | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  /** Saved crews that actually carry a graph — the only ones the canvas can draw. */
  const [graphCrews, setGraphCrews] = useState<Array<{ name: string; graph: Graph }>>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [promptText, setPromptText] = useState('');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [grantPickerOpen, setGrantPickerOpen] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [interruptArmed, setInterruptArmed] = useState(false);
  const [dismissedDriverRequests, setDismissedDriverRequests] = useState<Set<string>>(new Set());
  const [recentRooms, setRecentRooms] = useState<RecentRoom[]>(() => readRecentRooms());
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- phase-17a: the VS Code-shaped shell's own state ---
  const [sideBarOpen, setSideBarOpen] = useState(true);
  const [sideBarView, setSideBarView] = useState<SideBarView>('explorer');
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelHeight, setPanelHeight] = useState<number>(LAYOUT.panelDefaultHeight);
  /**
   * The open-files tab strip. One state object (not two) so a close never
   * observes a stale `active` from a separate, not-yet-applied `tabs` update —
   * see `closeTab` below.
   */
  const [tabState, setTabState] = useState<{ paths: string[]; active: string | null }>({
    paths: [],
    active: null,
  });
  /** Whether the editor auto-opens the agent's current file — the same
   *  follow/pin concept `WorkspacePane` had (11a), now driving which tab is
   *  active rather than a single `selectedPath`. */
  const [autoFollow, setAutoFollow] = useState(true);
  const [dirtyPaths, setDirtyPaths] = useState<Record<string, boolean>>({});
  const [gitStatus, setGitStatus] = useState<GitStatusState>({ status: 'loading' });
  const [gitStatusRequested, setGitStatusRequested] = useState(false);
  const seenApprovalIds = useRef<Set<string>>(new Set());

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
  const approvalCount = hasFleet ? fleetApprovals.length : pendingApprovals.length;

  useEffect(() => {
    // Room-scoped and token-carrying, like every other write-capable route
    // here — see ConfigLibrary.tsx for why an unscoped config endpoint was the
    // wrong answer even though a config is not room state.
    void fetch(`/api/rooms/${encodeURIComponent(params.roomId)}/configs`, {
      headers: { 'X-Nexus-Token': params.token },
    })
      .then((r) => (r.ok ? r.json() : { crews: [] }))
      .then((body: { crews?: Array<{ name: string; graph?: Graph }> }) => {
        setGraphCrews(
          (body.crews ?? [])
            .filter((c): c is { name: string; graph: Graph } => c.graph !== undefined)
            .map((c) => ({ name: c.name, graph: c.graph })),
        );
      })
      .catch(() => setGraphCrews([]));
  }, [params.roomId, params.token]);

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

  // --- phase-17a: file tree, tabs and the editor area ---
  // Ported from `WorkspacePane` (11a/11b), which this layout no longer
  // renders as a unit — its pieces (`FileTree`, `CodeEditor`, `ChangesTab`)
  // now live in separate regions, so the state that glued them together
  // lives here instead.
  const touchedFiles = useMemo(() => deriveTouchedFiles(view.events), [view.events]);
  const currentFile = useMemo(() => deriveCurrentFile(view.events), [view.events]);
  const loggedEditSeq = useMemo(() => deriveLatestEditSeqByPath(view.events), [view.events]);
  const editSeqByPath = useMemo(
    () => withExternalChanges(loggedEditSeq, view.externalChanges),
    [loggedEditSeq, view.externalChanges.nonce],
  );
  const workspace = useWorkspace(workspaceApi, editSeqByPath);

  /** Opens (or focuses, if already open) a tab. Manual selection — from the
   *  file tree or quick-open — also turns auto-follow off, the same "picking
   *  a file by hand stops following the agent" rule 11a's pin toggle had. */
  function selectFile(path: string): void {
    setAutoFollow(false);
    setTabState((current) => ({
      paths: current.paths.includes(path) ? current.paths : [...current.paths, path],
      active: path,
    }));
  }

  function closeTab(path: string): void {
    setTabState((current) => closeTabState(current, path));
  }

  // Auto-follow: every time the agent's current file changes, open (or
  // refocus) a tab for it — unless a person has taken manual control
  // (`autoFollow === false`). Flipping `autoFollow` back on re-runs this with
  // the same `currentFile`, which is what makes "Following" immediately jump
  // back to what the agent is doing rather than waiting for the NEXT change.
  useEffect(() => {
    if (!autoFollow || currentFile === null) return;
    setTabState((current) => ({
      paths: current.paths.includes(currentFile) ? current.paths : [...current.paths, currentFile],
      active: currentFile,
    }));
  }, [autoFollow, currentFile]);

  useEffect(() => {
    const path = tabState.active;
    if (path === null) return;
    if (workspace.files.has(path)) return;
    workspace.fetchFile(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabState.active]);

  // Dirty-tab tracking (see `isTabDirty`'s doc comment for exactly what this
  // does and does not detect). Only the ACTIVE tab has a live `CodeEditor` —
  // and therefore a live `docSession` subscription — mounted at all
  // (`CodeEditor`'s `key={path}` unmounts the previous file's view on every
  // switch), so this can only ever speak to the active path; recomputed on
  // the same 1s tick the rest of the room already uses, since there is no
  // local-edit callback on `DocSession` to subscribe to instead.
  useEffect(() => {
    const path = tabState.active;
    if (path === null || docSession === null) return;
    const cached = workspace.files.get(path);
    const cachedContent =
      cached !== undefined &&
      (cached.status === 'ready' || cached.status === 'stale') &&
      cached.result.kind === 'text'
        ? cached.result.content
        : null;
    const dirty = isTabDirty(cachedContent, docSession.text(path));
    setDirtyPaths((current) => (current[path] === dirty ? current : { ...current, [path]: dirty }));
  }, [now, tabState.active, docSession, workspace.files]);

  function loadGitStatus(): void {
    setGitStatus({ status: 'loading' });
    workspaceApi
      .getGitStatus()
      .then((entries: GitStatusEntry[]) => setGitStatus({ status: 'ready', entries }))
      .catch((error: unknown) => {
        const message = error instanceof WorkspaceError ? error.message : 'Failed to load git status.';
        setGitStatus({ status: 'error', message });
      });
  }

  useEffect(() => {
    if (sideBarView !== 'changes' || gitStatusRequested) return;
    setGitStatusRequested(true);
    loadGitStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideBarView, gitStatusRequested]);

  // A pending approval is the most governance-critical thing on screen (§1)
  // — surfacing it behind a click a person has to think to make would be a
  // visibility regression, not a tidy sidebar. So a NEWLY appeared request
  // (fleet or solo) switches the side bar to Approvals on its own; a request
  // that was already pending when this ran (or one already decided) does not
  // re-trigger it, and a person who has since switched to another view for
  // an OLDER request is not yanked back.
  useEffect(() => {
    const currentIds = new Set(
      hasFleet ? fleetApprovals.map((r) => r.requestId) : pendingApprovals.map((p) => p.requestId),
    );
    let hasNew = false;
    for (const id of currentIds) {
      if (!seenApprovalIds.current.has(id)) {
        hasNew = true;
        break;
      }
    }
    seenApprovalIds.current = currentIds;
    if (hasNew) {
      setSideBarView('approvals');
      setSideBarOpen(true);
    }
  }, [hasFleet, fleetApprovals, pendingApprovals]);

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
    { combo: 'mod+b', handler: () => setSideBarOpen((open) => !open), allowInInput: true, description: 'Toggle the side bar' },
    { combo: 'mod+j', handler: () => setPanelOpen((open) => !open), allowInInput: true, description: 'Toggle the panel' },
    { combo: 'mod+p', handler: () => setQuickOpenOpen(true), allowInInput: true, description: 'Go to file' },
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

  const activityItems: ActivityBarItem[] = [
    { id: 'explorer', label: 'Explorer', Icon: FolderTree },
    ...(hasFleet ? [{ id: 'fleet' as const, label: 'Fleet', Icon: Users, badge: view.fleet.length }] : []),
    { id: 'approvals', label: 'Approvals', Icon: ShieldAlert, badge: approvalCount },
    { id: 'changes', label: 'Changes', Icon: GitCompare },
  ];

  const tabStripTabs: OpenTab[] = tabState.paths.map((path) => ({ path, dirty: dirtyPaths[path] ?? false }));
  const activeCached = tabState.active !== null ? workspace.files.get(tabState.active) : undefined;

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

      {/* --- BEGIN phase-3d error banner slot: render <ErrorBanner/> here. --- */}
      <ErrorBanner message={bannerMessage} onDismiss={() => setDismissedCount(view.errorCount)} />
      {/* --- END phase-3d error banner slot --- */}

      {/* --- BEGIN phase-17a VS Code shell --- */}
      {/* Five regions: activity bar, side bar, editor (tab strip + CodeEditor),
          bottom panel (transcript), status bar. Below Tailwind's `lg`
          breakpoint (1024px — this project defines no custom breakpoints, so
          `lg:` is the stock value, not the ~900px an earlier comment claimed)
          the side bar is
          positioned as an overlay rather than taking permanent horizontal
          space (`lg:` below) — see the phase-17a plan's "responsive floor". */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <PaneErrorBoundary label="The activity bar">
          <ActivityBar
            items={activityItems}
            activeView={sideBarOpen ? sideBarView : null}
            onSelect={(nextView) => {
              if (sideBarOpen && sideBarView === nextView) {
                setSideBarOpen(false);
              } else {
                setSideBarView(nextView);
                setSideBarOpen(true);
              }
            }}
          />
        </PaneErrorBoundary>

        {sideBarOpen && (
          <div className="fixed inset-y-0 left-12 z-20 lg:static lg:z-auto">
            {/* A last-resort boundary for anything in the side bar OUTSIDE the
                per-view boundary `SideBar` now owns (its header, its own
                layout). Keyed by view for the same reason that one is: an
                error boundary never resets itself, so without a key a single
                throw would freeze this region for the rest of the session.
                View content is caught deeper and never reaches here — see the
                long comment in SideBar.tsx. */}
            <PaneErrorBoundary key={sideBarView} label="The side bar">
              <SideBar
                view={sideBarView}
                workspaceApi={workspaceApi}
                selectedPath={tabState.active}
                touchedPaths={touchedFiles}
                onSelectFile={selectFile}
                autoFollow={autoFollow}
                onToggleFollow={() => setAutoFollow((follow) => !follow)}
                fleetAgents={view.fleet}
                focusedAgentId={focusedAgentId}
                onFocusAgent={setFocusedAgentId}
                onSpawnAgent={(spawnParams) => connection?.send({ kind: 'spawn_agent', ...spawnParams })}
                onStopAgent={(agentId) => connection?.send({ kind: 'stop_agent', agentId })}
                hasFleet={hasFleet}
                fleetApprovals={fleetApprovals}
                singleApprovals={pendingApprovals}
                now={now}
                onDecideFleet={(requestId, agentId, decision, reason) =>
                  connection?.send({
                    kind: 'permission_decision',
                    requestId,
                    decision,
                    agentId,
                    ...(reason === undefined ? {} : { reason }),
                  })
                }
                onDecideSingle={(requestId, decision, reason) =>
                  connection?.send(
                    reason === undefined
                      ? { kind: 'permission_decision', requestId, decision }
                      : { kind: 'permission_decision', requestId, decision, reason },
                  )
                }
                changesEvents={view.events}
                gitStatus={gitStatus}
              />
            </PaneErrorBoundary>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <PaneErrorBoundary label="The editor">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {graphCrews.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs text-fg-muted">
                  <span>Workflows:</span>
                  {graphCrews.map((crew) => (
                    <button
                      key={crew.name}
                      type="button"
                      onClick={() => {
                        setCanvasGraph(crew.graph);
                        setRunError(null);
                      }}
                      className="rounded border border-border px-2 py-1 text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      {crew.name}
                    </button>
                  ))}
                  {canvasGraph !== null && (
                    <>
                      <Button
                        onClick={() => {
                          const crew = graphCrews.find((c) => c.graph === canvasGraph);
                          if (crew === undefined) return;
                          setRunError(null);
                          void fetch(
                            `/api/rooms/${encodeURIComponent(params.roomId)}/crews/${encodeURIComponent(crew.name)}/run`,
                            {
                              method: 'POST',
                              headers: {
                                'X-Nexus-Token': params.token,
                                'content-type': 'application/json',
                              },
                              body: JSON.stringify({ prompt: promptText.trim() || 'Begin.' }),
                            },
                          )
                            .then(async (r) => {
                              if (r.ok) return;
                              const body = (await r.json().catch(() => ({}))) as { error?: string };
                              // Every node in a graph is an agent that will ask
                              // permission; a refusal here is usually the fleet's
                              // resource cap, and the person needs to be told
                              // which rather than left guessing.
                              setRunError(body.error ?? 'Could not start that workflow.');
                            })
                            .catch(() => setRunError('Could not reach the server.'));
                        }}
                      >
                        Run
                      </Button>
                      <button
                        type="button"
                        onClick={() => setCanvasGraph(null)}
                        className="rounded border border-border px-2 py-1 hover:bg-surface-2"
                      >
                        Close
                      </button>
                    </>
                  )}
                  {runError !== null && <span className="text-danger">{runError}</span>}
                </div>
              )}

              {canvasGraph !== null && (
                <div className="relative m-3 h-72 shrink-0 overflow-hidden rounded-lg border border-border">
                  <Canvas
                    graph={canvasGraph}
                    selectedNodeId={selectedNodeId}
                    onSelect={setSelectedNodeId}
                    onNodeMove={(id, x, y) =>
                      setCanvasGraph((g) =>
                        g === null
                          ? g
                          : { ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) },
                      )
                    }
                  />
                  {/* Live status comes from the transient `fleet` frame; MEMBERSHIP
                      still comes from the log. Not a third source of truth. */}
                  <RunOverlay graph={canvasGraph} fleet={view.fleet} />
                </div>
              )}

              <TabStrip
                tabs={tabStripTabs}
                activePath={tabState.active}
                onSelect={(path) => setTabState((current) => ({ ...current, active: path }))}
                onClose={closeTab}
              />
              <div className="min-h-0 flex-1 overflow-hidden">
                <CodeEditor
                  path={tabState.active}
                  cached={activeCached}
                  onRefresh={workspace.refetchFile}
                  {...(docSession === null ? {} : { docSession })}
                  {...(view.selfId === null ? {} : { selfId: view.selfId })}
                />
              </div>
            </div>
          </PaneErrorBoundary>

          <PaneErrorBoundary label="The transcript panel">
            <Panel
              open={panelOpen}
              onToggleOpen={() => setPanelOpen((open) => !open)}
              height={panelHeight}
              onHeightChange={setPanelHeight}
              agentStatus={agentStatus}
              now={now}
            >
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

              <div className="min-h-0 flex-1">
                <MessageList events={focusedEvents} pendingDeltas={view.pendingDeltas} />
              </div>

              {/*
                The input is gated on connection state only, never on the driver token —
                that is the point of I2'. Anyone may speak; the server orders, attributes
                and batches, and the agent resolves genuine conflicts in the driver's
                favour. Adding a driver check here would undo the feature.
              */}
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
            </Panel>
          </PaneErrorBoundary>
        </div>
      </div>

      <PaneErrorBoundary label="The status bar">
        <StatusBar
          events={view.events}
          roomId={params.roomId}
          participants={view.participants}
          driverId={view.driverId}
          // A room always has at least the primary agent even before the
          // first `fleet` frame has arrived (it defaults to `[]` — see
          // `store.ts`) — reporting 0 in that window would be wrong, not
          // merely stale.
          agentCount={Math.max(1, view.fleet.length)}
          status={status}
        />
      </PaneErrorBoundary>
      {/* --- END phase-17a VS Code shell --- */}

      <JoinToasts events={view.events} selfId={view.selfId} replaying={view.replaying} />

      <GrantControlPicker
        open={grantPickerOpen}
        participants={view.participants}
        selfId={view.selfId}
        onGrant={(participantId) => connection?.send({ kind: 'grant_control', toParticipantId: participantId })}
        onClose={() => setGrantPickerOpen(false)}
      />

      <QuickOpenDialog
        open={quickOpenOpen}
        api={workspaceApi}
        onOpen={selectFile}
        onClose={() => setQuickOpenOpen(false)}
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
