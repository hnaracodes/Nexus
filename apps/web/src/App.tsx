import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderTree, GitCompare, Network, Search } from 'lucide-react';
import { deriveApprovals } from './approvals.js';
import type { PendingApproval } from './approvals.js';
import { ConnectionStatus } from './components/ConnectionStatus.js';
import { ErrorBanner } from './components/ErrorBanner.js';
import { EMPTY_VIEW } from './store.js';
import type { RoomView } from './store.js';
import { connect } from './ws.js';
import type { Connection, Status, WebSocketLike } from './ws.js';
import type { AgentId, SynCodeEvent } from '@syncode/protocol/events';
import { PRIMARY_AGENT_ID, agentIdOf } from '@syncode/protocol/events';
// phase-5a import anchor
import { MalformedLink } from './pages/MalformedLink.js';
// phase-7b import anchor
// phase-18 agents-view import anchor
import { AgentsView } from './canvas/AgentsView.js';
import type { FleetApprovalRequest } from './components/ApprovalQueue.js';
import { PaneErrorBoundary } from './components/PaneErrorBoundary.js';
import { createWorkspaceApi, fetchGitBranch } from './workspace/workspaceApi.js';
import type { DocSession } from './workspace/docSession.js';
import { useWorkspace } from './workspace/useWorkspace.js';
import { WorkspaceError } from './workspace/types.js';
import type { GitStatusEntry } from './workspace/types.js';
import { deriveCurrentFile, deriveLatestEditSeqByPath, deriveTouchedFiles } from './derive/workspaceFiles.js';
import { DENIED_MS, deriveGhosts, roomCwd, typingGhostPath, workspaceRelative } from './derive/ghosts.js';
import { withExternalChanges } from './derive/externalChanges.js';
// phase-7c import anchor
import { JoinGate, readStoredName, storeName } from './components/JoinGate.js';
import { JoinToasts } from './components/JoinToasts.js';
// phase-5b import anchor
import { useHotkeys } from './hooks/useHotkeys.js';
import type { Hotkey } from './hooks/useHotkeys.js';
import { RoomHeader } from './components/RoomHeader.js';
import { AutoModeBanner } from './components/AutoModeBanner.js';
import { deriveAutoMode } from './derive/autoMode.js';
import { TerminalPanel } from './terminal/TerminalPanel.js';
import { deriveDetectedRepo, deriveGithubBinding } from './githubBinding.js';
import { shareableRoomLink } from './shareLink.js';
import type { ShareableRoomLink } from './shareLink.js';
import { deriveAgentStatus } from './agentStatus.js';
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
import { AGENTS_TAB_ID, isTabDirty } from './components/TabStrip.js';
import type { OpenTab } from './components/TabStrip.js';
import { Panel } from './components/Panel.js';
import type { PanelTab } from './components/Panel.js';
import { StatusBar } from './components/StatusBar.js';
import type { GitStatusState } from './components/ChangesTab.js';
import { AuxBar } from './components/AuxBar.js';
import type { AuxView } from './components/AuxBar.js';
import { AgentChatView } from './components/AgentChatView.js';
import { EditorArea } from './components/EditorArea.js';
import { OutputPanel } from './components/OutputPanel.js';
import { DiffPanel } from './components/DiffPanel.js';
import { ResizeHandle } from './components/ResizeHandle.js';
import { QuickOpenDialog } from './components/QuickOpenDialog.js';
import { GrantControlPicker } from './components/GrantControlPicker.js';
import { fileKind, languageLabel } from './workspace/fileKinds.js';
import { AUX_BAR, PANEL, SIDE_BAR } from './layout/dimensions.js';

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
function deriveRoomLabel(events: SynCodeEvent[], roomId: string): string {
  const created = events.find((event): event is Extract<SynCodeEvent, { type: 'room_created' }> =>
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
  // `paths` holds tab IDS: workspace paths, plus the reserved `AGENTS_TAB_ID`.
  // The rule is identical for both kinds of tab.
  const idx = current.paths.indexOf(path);
  if (idx === -1) return current;
  const paths = current.paths.filter((p) => p !== path);
  // Closing a background tab never moves focus.
  if (current.active !== path) return { paths, active: current.active };
  const active = paths.length === 0 ? null : (paths[Math.min(idx, paths.length - 1)] ?? null);
  return { paths, active };
}

/**
 * Whether Cmd/Ctrl+Shift+V should toggle the Markdown preview for this key
 * event. It declines (so the browser keeps the key) unless the active tab is a
 * Markdown file — and ALWAYS inside a plain text box: in the prompt box that
 * chord is "paste as plain text". Inside CodeMirror (a contenteditable div) it
 * applies, since an editor has no use for that chord.
 */
export function previewHotkeyApplies(target: EventTarget | null, activeFilePath: string | null): boolean {
  if (activeFilePath === null || fileKind(activeFilePath) !== 'markdown') return false;
  return !(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement);
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
  // What "Copy room link" hands out. Never carries `name` (it would make the
  // recipient join as us) and never trusts a loopback origin (it would point
  // the recipient at their own machine). See shareLink.ts.
  const shareLink = shareableRoomLink({
    shareLinks: view.shareLinks,
    origin: globalThis.location.origin,
    hostname: globalThis.location.hostname,
    roomId: params.roomId,
    token: params.token,
  });
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
      shareLink={shareLink}
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
  shareLink,
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
  shareLink: ShareableRoomLink;
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
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [interruptArmed, setInterruptArmed] = useState(false);
  const [dismissedDriverRequests, setDismissedDriverRequests] = useState<Set<string>>(new Set());
  const [recentRooms, setRecentRooms] = useState<RecentRoom[]>(() => readRecentRooms());
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- phase-17a: the VS Code-shaped shell's own state ---
  const [sideBarOpen, setSideBarOpen] = useState(true);
  const [sideBarView, setSideBarView] = useState<SideBarView>('explorer');
  const [sideBarWidth, setSideBarWidth] = useState<number>(SIDE_BAR.default);
  const [searchFocusNonce, setSearchFocusNonce] = useState(0);
  // phase-18b: the right-hand auxiliary bar (Chat / Approvals / Fleet). Open by
  // default only where it can sit beside the editor; below `lg` it is an overlay.
  const [auxOpen, setAuxOpen] = useState(() => globalThis.innerWidth >= 1024);
  const [auxView, setAuxView] = useState<AuxView>('chat');
  const [auxWidth, setAuxWidth] = useState<number>(AUX_BAR.default);
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelHeight, setPanelHeight] = useState<number>(PANEL.default);
  const [panelTab, setPanelTab] = useState<PanelTab>('output');
  /** The changed file whose diff the DIFF tab shows. */
  const [diffPath, setDiffPath] = useState<string | null>(null);
  /** Markdown tabs whose side-by-side preview is open — per tab, remembered. */
  const [previewIds, setPreviewIds] = useState<Set<string>>(new Set());
  /** Caret of the most recent editor, tagged with its path so a stale value
   *  from a previous tab is never shown against the current one. */
  const [cursor, setCursor] = useState<{ path: string; line: number; col: number } | null>(null);
  /**
   * The open editor tabs. One state object (not two) so a close never observes
   * a stale `active` from a separate, not-yet-applied `tabs` update — see
   * `closeTab` below. `paths` holds tab ids: workspace paths and the reserved
   * `AGENTS_TAB_ID` for the Agents tab.
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
      .filter((e): e is Extract<SynCodeEvent, { type: 'permission_requested' }> =>
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

  const workspaceApi = useMemo(
    () => createWorkspaceApi({ roomId: params.roomId, token: params.token }),
    [params.roomId, params.token],
  );

  // Live branch of a local folder's git checkout, shown beside a repo detected
  // from its remote (no publish binding). Polled because the branch can change
  // under the room (the shared terminal, a checkout); skipped entirely unless
  // the room actually has a detected repo.
  const hasDetectedRepo =
    deriveGithubBinding(view.events) === null && deriveDetectedRepo(view.events) !== null;
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  useEffect(() => {
    if (!hasDetectedRepo) return;
    let cancelled = false;
    const load = (): void => {
      if (document.visibilityState === 'hidden') return;
      fetchGitBranch({ roomId: params.roomId, token: params.token })
        .then((branch) => {
          if (!cancelled) setGitBranch(branch);
        })
        .catch(() => {
          // Unknown branch: the bar shows owner/repo alone.
        });
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hasDetectedRepo, params.roomId, params.token]);

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
  // --- BEGIN phase-21 ghosts ---
  // Agent edits as proposals: typing (live), waiting for approval, applying,
  // then a brief landed/denied state. `ghostNow` only ticks while one of those
  // brief states is on screen, so an idle room re-renders nothing.
  const cwd = useMemo(() => roomCwd(view.events), [view.events]);
  const [ghostNow, setGhostNow] = useState(() => Date.now());
  const ghosts = useMemo(
    () => deriveGhosts(view.events, view.livePreviews, ghostNow),
    [view.events, view.livePreviews, ghostNow],
  );
  const settling = ghosts.some((ghost) => ghost.phase === 'landed' || ghost.phase === 'denied');
  useEffect(() => {
    if (!settling) return;
    setGhostNow(Date.now());
    const timer = setInterval(() => setGhostNow(Date.now()), 250);
    const stop = setTimeout(() => clearInterval(timer), DENIED_MS + 500);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [settling]);
  // Following jumps to the file the moment the agent starts typing into it;
  // otherwise it follows the agent's tools as before. Relative, so it is the
  // same tab the file tree opens rather than a second one for the same file.
  const agentFile = useMemo(() => deriveCurrentFile(view.events), [view.events]);
  const currentFile = useMemo(() => {
    const typing = typingGhostPath(ghosts);
    if (typing !== null) return typing;
    return agentFile === null ? null : (workspaceRelative(agentFile, cwd) ?? agentFile);
  }, [ghosts, agentFile, cwd]);
  // --- END phase-21 ghosts ---
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

  function closeTab(id: string): void {
    setTabState((current) => closeTabState(current, id));
  }

  /** Opens the Agents tab (once) or refocuses it. */
  function openAgentsTab(): void {
    setTabState((current) => ({
      paths: current.paths.includes(AGENTS_TAB_ID) ? current.paths : [...current.paths, AGENTS_TAB_ID],
      active: AGENTS_TAB_ID,
    }));
  }

  /** Reveals the aux bar on a given view — also the force-open an approval uses. */
  function openAux(next: AuxView): void {
    setAuxView(next);
    setAuxOpen(true);
  }

  /** A changed file was clicked in Source Control: open it AND show its diff. */
  function openChangedFile(path: string): void {
    selectFile(path);
    setDiffPath(path);
    setPanelTab('diff');
    setPanelOpen(true);
  }

  const activeFilePath =
    tabState.active !== null && tabState.active !== AGENTS_TAB_ID ? tabState.active : null;
  const activeKind = activeFilePath === null ? null : fileKind(activeFilePath);

  function togglePreview(): void {
    if (activeFilePath === null) return;
    setPreviewIds((current) => {
      const next = new Set(current);
      if (!next.delete(activeFilePath)) next.add(activeFilePath);
      return next;
    });
  }

  // Auto-follow: every time the agent's current file changes, open (or
  // refocus) a tab for it — unless a person has taken manual control
  // (`autoFollow === false`). It NEVER steals the editor from the Agents tab:
  // while that tab is active a followed file opens in the background. Flipping `autoFollow` back on re-runs this with
  // the same `currentFile`, which is what makes "Following" immediately jump
  // back to what the agent is doing rather than waiting for the NEXT change.
  useEffect(() => {
    if (!autoFollow || currentFile === null) return;
    setTabState((current) => ({
      paths: current.paths.includes(currentFile) ? current.paths : [...current.paths, currentFile],
      active: current.active === AGENTS_TAB_ID ? current.active : currentFile,
    }));
  }, [autoFollow, currentFile]);

  useEffect(() => {
    const path = tabState.active;
    // Images are fetched as bytes by `ImagePreview`, not as text here.
    if (path === null || path === AGENTS_TAB_ID || fileKind(path) === 'image') return;
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
    if (path === null || path === AGENTS_TAB_ID || docSession === null) return;
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
  // (fleet or solo) switches the aux bar to Approvals on its own; a request
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
      // Force-open the aux bar on Approvals, even if it was collapsed or on
      // Chat. A person collapsing it by hand is allowed; the next NEW request
      // opens it again.
      setAuxView('approvals');
      setAuxOpen(true);
    }
  }, [hasFleet, fleetApprovals, pendingApprovals]);

  /**
   * Who the chat is talking to. The agent picker chooses whose transcript is
   * shown, and what you type or stop must go to that same agent — before this,
   * picking "Beta" changed only the transcript while prompts and Stop still
   * went to the primary agent. The primary agent keeps the bare frame (no
   * `agentId`), byte-identical to a pre-fleet room.
   */
  const chatTarget: { agentId?: AgentId } = focusedAgentId === null ? {} : { agentId: focusedAgentId };

  function submitPrompt(): void {
    const trimmed = promptText.trim();
    if (trimmed === '') return;
    connection?.send({ kind: 'prompt', text: trimmed, ...chatTarget });
    setPromptText('');
  }

  function toggleDriver(): void {
    connection?.send({ kind: iAmDriving ? 'release_control' : 'request_control' });
  }

  function handleInterruptHotkey(): void {
    if (interruptArmed) {
      connection?.send({ kind: 'interrupt', ...chatTarget });
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
    { combo: 'mod+alt+b', handler: () => setAuxOpen((open) => !open), allowInInput: true, description: 'Toggle the agent bar' },
    { combo: 'mod+j', handler: () => setPanelOpen((open) => !open), allowInInput: true, description: 'Toggle the panel' },
    { combo: 'mod+p', handler: () => setQuickOpenOpen(true), allowInInput: true, description: 'Go to file' },
    {
      combo: 'mod+shift+v',
      handler: togglePreview,
      allowInInput: true,
      when: (event) => previewHotkeyApplies(event.target, activeFilePath),
      description: 'Toggle Markdown preview',
    },
    {
      combo: 'mod+shift+e',
      handler: () => {
        setSideBarView('explorer');
        setSideBarOpen(true);
      },
      allowInInput: true,
      description: 'Show the Explorer',
    },
    {
      combo: 'mod+shift+f',
      handler: () => {
        setSideBarView('search');
        setSideBarOpen(true);
        setSearchFocusNonce((n) => n + 1);
      },
      allowInInput: true,
      description: 'Search files',
    },
    { combo: 'mod+alt+c', handler: () => openAux('chat'), allowInInput: true, description: 'Show Chat' },
    { combo: 'mod+alt+a', handler: () => openAux('approvals'), allowInInput: true, description: 'Show Approvals' },
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

  // A fleet that shrinks back to one agent must not leave the aux bar on a
  // Fleet view that no longer exists.
  const effectiveAuxView: AuxView = auxView === 'fleet' && !hasFleet ? 'chat' : auxView;

  const leftItems: ActivityBarItem[] = [
    { id: 'explorer', label: 'Explorer', Icon: FolderTree },
    { id: 'search', label: 'Search', Icon: Search },
    { id: 'changes', label: 'Source Control', Icon: GitCompare },
  ];

  const tabStripTabs: OpenTab[] = tabState.paths.map((id) =>
    id === AGENTS_TAB_ID
      ? { id, kind: 'agents', dirty: false }
      : { id, kind: 'file', dirty: dirtyPaths[id] ?? false },
  );
  const activeCached = activeFilePath !== null ? workspace.files.get(activeFilePath) : undefined;
  const autoMode = deriveAutoMode(view.events);

  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      <NoticeStack notices={notices} />

      {/* Title bar: the old RoomHeader, re-skinned. Roster + driver controls,
          agent activity, Cmd+K and ? all live here still. */}
      <RoomHeader
        roomLabel={roomLabel}
        shareLink={shareLink}
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
        autoMode={autoMode}
        onSetAutoMode={(enabled) => connection?.send({ kind: 'set_auto_mode', enabled })}
        auxOpen={auxOpen}
        onToggleAux={() => setAuxOpen((open) => !open)}
        pendingApprovals={approvalCount}
      />

      {/* Phase 19a: everyone sees, and anyone can undo, auto mode. */}
      <AutoModeBanner
        autoMode={autoMode}
        onTurnOff={() => connection?.send({ kind: 'set_auto_mode', enabled: false })}
      />

      {/* --- BEGIN phase-3d error banner slot: render <ErrorBanner/> here. --- */}
      <ErrorBanner message={bannerMessage} onDismiss={() => setDismissedCount(view.errorCount)} />
      {/* --- END phase-3d error banner slot --- */}

      {/* --- BEGIN phase-18b VS Code shell --- */}
      {/* Left: activity bar + side bar (FILES). Centre: editor tabs over a
          bottom panel. Right: auxiliary bar (AGENTS) + secondary activity bar.
          Below Tailwind's `lg` breakpoint (1024px) BOTH side bars are fixed
          overlays rather than permanent columns. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <PaneErrorBoundary label="The activity bar">
          <ActivityBar
            items={leftItems}
            activeView={sideBarOpen ? sideBarView : null}
            onSelect={(nextView) => {
              if (sideBarOpen && sideBarView === nextView) {
                setSideBarOpen(false);
              } else {
                setSideBarView(nextView);
                setSideBarOpen(true);
              }
            }}
            actions={[
              {
                id: 'agents',
                label: 'Agents',
                Icon: Network,
                active: tabState.active === AGENTS_TAB_ID,
                onClick: openAgentsTab,
              },
            ]}
          />
        </PaneErrorBoundary>

        {sideBarOpen && (
          <>
            <div
              className="fixed bottom-[22px] left-12 top-8 z-20 shrink-0 border-r border-border lg:static lg:z-auto"
              style={{ width: sideBarWidth, maxWidth: 'calc(100vw - 96px)' }}
            >
              {/* Keyed by view for the same reason SideBar keys its inner one:
                  a boundary never resets itself, so without a key one throw
                  would freeze this region for the rest of the session. */}
              <PaneErrorBoundary key={sideBarView} label="The side bar">
                <SideBar
                  view={sideBarView}
                  workspaceApi={workspaceApi}
                  selectedPath={activeFilePath}
                  touchedPaths={touchedFiles}
                  onSelectFile={selectFile}
                  autoFollow={autoFollow}
                  onToggleFollow={() => setAutoFollow((follow) => !follow)}
                  searchFocusNonce={searchFocusNonce}
                  changesEvents={view.events}
                  gitStatus={gitStatus}
                  onOpenChangedFile={openChangedFile}
                />
              </PaneErrorBoundary>
            </div>
            <div className="hidden lg:block">
              <ResizeHandle
                label="Resize side bar"
                orientation="vertical"
                value={sideBarWidth}
                min={SIDE_BAR.min}
                max={SIDE_BAR.max}
                onChange={setSideBarWidth}
              />
            </div>
          </>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <PaneErrorBoundary label="The editor">
            <EditorArea
              tabs={tabStripTabs}
              activeId={tabState.active}
              onSelectTab={(id) => setTabState((current) => ({ ...current, active: id }))}
              onCloseTab={closeTab}
              api={workspaceApi}
              cached={activeCached}
              onRefresh={workspace.refetchFile}
              docSession={docSession}
              selfId={view.selfId}
              previewOpen={activeFilePath !== null && previewIds.has(activeFilePath)}
              onTogglePreview={togglePreview}
              onCursorChange={(path, c) => setCursor({ path, ...c })}
              agentsView={
                <>
                  {/* --- BEGIN phase-18 agents-view slot: the shell owns WHERE, canvas/ owns WHAT. --- */}
                  <AgentsView
                    roomId={params.roomId}
                    token={params.token}
                    fleet={view.fleet}
                    focusedAgentId={focusedAgentId}
                    onFocusAgent={setFocusedAgentId}
                    onSpawnAgent={(spawnParams) => connection?.send({ kind: 'spawn_agent', ...spawnParams })}
                    onStopAgent={(agentId) => connection?.send({ kind: 'stop_agent', agentId })}
                    onOpenAgentChat={(agentId) => {
                      setFocusedAgentId(agentId);
                      openAux('chat');
                    }}
                  />
                  {/* --- END phase-18 agents-view slot --- */}
                </>
              }
            />
          </PaneErrorBoundary>

          <PaneErrorBoundary label="The panel">
            <Panel
              open={panelOpen}
              onToggleOpen={() => setPanelOpen((open) => !open)}
              height={panelHeight}
              onHeightChange={setPanelHeight}
              activeTab={panelTab}
              onTabChange={(tab) => {
                setPanelTab(tab);
                setPanelOpen(true);
              }}
              tabs={view.terminals.available ? ['output', 'diff', 'terminal'] : ['output', 'diff']}
            >
              {panelTab === 'terminal' && view.terminals.available && connection !== null ? (
                <TerminalPanel
                  terminals={view.terminals}
                  hub={connection.terminals}
                  send={(frame) => connection.send(frame)}
                />
              ) : panelTab === 'diff' ? (
                <DiffPanel api={workspaceApi} path={diffPath} />
              ) : (
                <OutputPanel events={view.events} focusedAgentId={focusedAgentId} />
              )}
            </Panel>
          </PaneErrorBoundary>
        </div>

        {auxOpen && (
          <>
            <div className="hidden lg:block">
              <ResizeHandle
                label="Resize agent bar"
                orientation="vertical"
                value={auxWidth}
                min={AUX_BAR.min}
                max={AUX_BAR.max}
                invert
                onChange={setAuxWidth}
              />
            </div>
            <div
              className="fixed bottom-[22px] right-0 top-8 z-20 shrink-0 border-l border-border lg:static lg:z-auto"
              style={{ width: auxWidth, maxWidth: 'calc(100vw - 48px)' }}
            >
              <PaneErrorBoundary key={effectiveAuxView} label="The agent bar">
                <AuxBar
                  view={effectiveAuxView}
                  onViewChange={openAux}
                  chat={
                    <AgentChatView
                      roomId={params.roomId}
                      token={params.token}
                      events={view.events}
                      focusedEvents={focusedEvents}
                      pendingDeltas={view.pendingDeltas}
                      replaying={view.replaying}
                      fleet={view.fleet}
                      focusedAgentId={focusedAgentId}
                      onFocusAgent={setFocusedAgentId}
                      driverId={view.driverId}
                      selfId={view.selfId}
                      promptDisabled={status !== 'open'}
                      promptValue={promptText}
                      onPromptChange={setPromptText}
                      onSubmitPrompt={(text) => {
                        connection?.send({ kind: 'prompt', text, ...chatTarget });
                        setPromptText('');
                      }}
                      onStop={() => connection?.send({ kind: 'interrupt', ...chatTarget })}
                      onSetModel={(model) => connection?.send({ kind: 'set_model', model })}
                      onResendPrompt={(text) => connection?.send({ kind: 'prompt', text, ...chatTarget })}
                      onGrantControl={(participantId) =>
                        connection?.send({ kind: 'grant_control', toParticipantId: participantId })
                      }
                      dismissedDriverRequests={dismissedDriverRequests}
                      onDismissDriverRequest={(participantId) =>
                        setDismissedDriverRequests((current) => new Set(current).add(participantId))
                      }
                      approvalCount={approvalCount}
                      onReviewApprovals={() => openAux('approvals')}
                      gitBranch={gitBranch}
                    />
                  }
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
                />
              </PaneErrorBoundary>
            </div>
          </>
        )}
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
          cursor={
            cursor !== null && cursor.path === activeFilePath && activeKind !== 'image'
              ? { line: cursor.line, col: cursor.col }
              : null
          }
          language={activeFilePath !== null ? languageLabel(activeFilePath) : null}
          approvalCount={approvalCount}
          onOpenAgents={openAgentsTab}
          onOpenApprovals={() => openAux('approvals')}
          branch={gitBranch}
        />
      </PaneErrorBoundary>
      {/* --- END phase-18b VS Code shell --- */}

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
