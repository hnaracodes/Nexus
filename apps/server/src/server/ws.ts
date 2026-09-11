import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { AgentId, AgentProvider, NexusEvent, UnsequencedEvent } from '@syncode/protocol/events';
import { PRIMARY_AGENT_ID, agentIdOf } from '@syncode/protocol/events';
import type { DocPresenceEntry, ServerFrame } from '@syncode/protocol/wire';
import { createSink } from '../log/index.js';
import { projectAgents } from '../log/replay.js';
import { redactEvent } from '../log/redact.js';
import type { AgentDeps, AgentHandle } from './agent.js';
import { buildRosterView } from './fleet.js';
import type { Decision } from './permissions.js';
import { createDocRegistry } from './docs.js';
import { createApprovalQueue } from './approvalQueue.js';
import type { ApprovalQueue } from './approvalQueue.js';
import { fleetSnapshot } from './fleet.js';
import type { DocRegistry } from './docs.js';
import { createRuntime } from './runtime/factory.js';
import type { Room } from './rooms.js';
import { readWorkspaceFile } from './workspace.js';
import type { WorkspaceWatcherHandle } from './watcher.js';
import { startWorkspaceWatcher } from './watcher.js';

/**
 * `doc_sync.from` when no single peer authored the payload being sent: the
 * server's own full-history reply to a fresh `doc_open`, or an out-of-band
 * reconciliation (an agent's whole-file write, or the workspace watcher
 * noticing an external change). `docs.ts`'s `DocRegistryOptions.broadcastSync`
 * hands its callback only `(room, path, payloadBase64)` — no attributable id —
 * so this is the best available label for those two cases; see the session
 * report for the exact signature change that would let a real one through.
 * Deliberately NOT shaped like a real participant id (`p_…`) or a free-form
 * agent id, so it can never collide with one and a client's self-echo check
 * (`frame.from === selfId`) can never mistake it for "my own edit".
 */
const DOC_SYNC_NO_ORIGIN = 'server';

/** Implemented durably by `src/log/` (plan phase-1a). */
export interface EventSink {
  append(event: NexusEvent): void;
  read(): NexusEvent[];
}

/**
 * Non-durable sink, kept for tests that must not touch the filesystem. Never
 * the default: state that exists only in memory is lost on restart, which I3
 * forbids.
 */
export class MemorySink implements EventSink {
  #events: NexusEvent[] = [];
  append(event: NexusEvent): void {
    this.#events.push(event);
  }
  read(): NexusEvent[] {
    return this.#events;
  }
}

/**
 * Why a permission decision did or did not land.
 *
 * Deliberately not a boolean. The three causes need three different things said
 * to the person who clicked: 'settled' is done; 'not-found' really is "already
 * decided"; 'unknown-agent' means the request is STILL OPEN and still counting
 * down to a timeout-deny, so telling that person it was already decided makes
 * them stop watching an approval that then auto-denies — the exact opposite of
 * the guarantee the gate exists to provide.
 */
export type ResolveOutcome = 'settled' | 'not-found' | 'unknown-agent';

export interface RoomRuntime {
  room: Room;
  /**
   * The primary agent.
   *
   * Deliberately kept after phase 8b rather than removed. Three room-level
   * operations still reach for it — `listModels`, `set_model` and `interrupt` —
   * and each raises a question that belongs to phase 12, not here: does Stop
   * stop every agent or one, and is a model a property of the room or of an
   * agent? Answering those now, with no fleet to validate against, would be
   * guessing. Prompts and permission decisions ARE routed per agent, because
   * for those the right answer is already knowable.
   */
  readonly agent: AgentHandle;
  /**
   * Every agent attached to this room. One entry until phase 12; the map is
   * what lets there be more without reshaping the runtime again.
   */
  /** Read-only on purpose: `attachAgent` is I1's per-agent enforcement point,
   *  and a mutable Map here would let any holder of the runtime bypass it. */
  agents: ReadonlyMap<AgentId, AgentHandle>;
  /** Undefined for an unknown id — deliberately NOT a fallback to the primary
   *  agent, since silently steering the wrong agent is worse than failing. */
  getAgent(agentId?: AgentId): AgentHandle | undefined;
  /**
   * I1, re-scoped per agent: attaching an id that already exists returns the
   * existing handle rather than starting a second session for it. N agents may
   * coexist; a given agent is never re-instantiated, so no viewer and no second
   * attach can fork its context window.
   */
  attachAgent(agentId: AgentId, deps?: AgentDeps, provider?: AgentProvider): AgentHandle;
  /**
   * Stored so a future teardown path has something to close. There is no
   * room-teardown mechanism in this codebase today (`runtimes` only grows;
   * `__resetRuntimes()` is test-only) — this does not invent one, it just
   * avoids leaving the handle stranded nowhere if one is ever added.
   */
  workspaceWatcher: WorkspaceWatcherHandle;
  /**
   * The room-scoped collaborative document layer (phase 11). Exactly one
   * instance per room, created inside `attachRoom` below — never
   * module-level. `docs.ts`'s own module comment explains why: a shared
   * instance keyed only by path would let two rooms that happen to share a
   * relative path (both cloned the same starter repo) silently share one
   * CRDT document.
   */
  docs: DocRegistry;
  /**
   * Open `path` for `participantId` over `socket`: creates the document if it
   * doesn't exist yet, subscribes `socket` to its `doc_sync` stream, and sends
   * the initial full-history payload directly to `socket` (never broadcast —
   * every other socket with this path open already has this state).
   */
  docOpen(socket: WebSocket, participantId: string, path: string): Promise<void>;
  /**
   * Release `path` for `socket`/`participantId` alone. Other sockets or peers
   * with this path open are untouched.
   */
  docClose(socket: WebSocket, participantId: string, path: string): void;
  /**
   * Apply one inbound `doc_sync` payload from `participantId` and fan the
   * result out to every OTHER socket subscribed to `path` — never back to
   * `socket`, which already applied this change locally before sending it.
   */
  docApplySync(
    socket: WebSocket,
    participantId: string,
    path: string,
    payloadBase64: string,
  ): Promise<void>;
  /**
   * Record where `participantId`'s cursor sits in `path` and broadcast the
   * full roster to every socket subscribed to it — `socket` itself included,
   * since a second tab from the same person wants to see its own entry
   * reflected back too.
   */
  docSetPresence(
    socket: WebSocket,
    participantId: string,
    displayName: string,
    path: string,
    anchor: number,
    head: number,
  ): void;
  /**
   * Release every document subscription `socket` holds, across every path.
   * Call this on disconnect: a socket that closes without a matching
   * `doc_close` per path — the ordinary case, a closed tab — must not linger
   * in a subscriber set forever. That is both a slow memory leak and, the
   * next time the path syncs, a write to a closed socket.
   */
  docDisconnect(socket: WebSocket, participantId: string): void;
  sink: EventSink;
  broadcast(frame: ServerFrame): void;
  /** Seal an unsequenced event: assign seq + ts, append to the sink, broadcast. */
  commit(event: UnsequencedEvent): NexusEvent;
  /** `commit`, attributed to a specific agent. See the implementation for why
   *  the primary agent is deliberately left unstamped. */
  commitAs(agentId: AgentId, event: UnsequencedEvent): NexusEvent;
  /** The room's shared approval queue (phase 12). */
  approvals: ApprovalQueue;
  /** Broadcast the transient `fleet` frame — liveness, never membership. */
  broadcastFleet(): void;
  /**
   * Settle a pending approval on the agent that actually holds it.
   *
   * Request ids are minted per gate, so with more than one agent a bare id is
   * ambiguous. When the client names an agent, ONLY that agent's gate is tried;
   * a mismatch returns false rather than falling through, because settling a
   * different agent's tool call with a vote cast on this one is an unauthorised
   * approval, not a routing inconvenience. When no agent is named — every
   * pre-phase-8b client — the gates are searched, which is safe because ids are
   * random and unique in practice.
   */
  resolvePermission(requestId: string, decision: Decision, agentId?: AgentId): ResolveOutcome;
  addSocket(socket: WebSocket, participantId: string): void;
  removeSocket(socket: WebSocket): void;
  socketCount(): number;
  /**
   * How many open sockets currently share one identity. Once a reconnecting
   * client can reclaim its id, two tabs legitimately hold the same one, and
   * closing either must not be mistaken for the person leaving.
   */
  participantSocketCount(participantId: string): number;
}

const runtimes = new Map<string, RoomRuntime>();

export function attachRoom(
  room: Room,
  sink: EventSink = createSink(room.id),
  deps: AgentDeps = {},
): RoomRuntime {
  const existing = runtimes.get(room.id);
  if (existing !== undefined) return existing; // I1: never a second agent.

  const sockets = new Map<WebSocket, string>();

  const agents = new Map<AgentId, AgentHandle>();

  // Phase 11 document bookkeeping. Per room (these are local to this call),
  // never module-level — see the `docs` field's own doc comment above.
  //
  // `docSubscribers` is keyed by the path exactly as a client spelled it in
  // `doc_open`, NOT by `docs.ts`'s internal jailed-and-normalized key (that
  // canonicalization is private to `docs.ts` and never returned to a caller).
  // In practice every client reaches a path through the same source — the
  // workspace tree / `useWorkspace` — so this never diverges; a client that
  // opened the same file under two different spellings (`a.ts` vs `./a.ts`)
  // would see two independent subscriber sets for what `docs.ts` treats as
  // one document. Documented, not fixed, here: fixing it needs `docs.ts` to
  // expose its canonical key, and that file belongs to a different owner.
  const docSubscribers = new Map<string, Set<WebSocket>>();
  // The inverse index: which paths a given SOCKET has open, so a disconnect
  // can release exactly that socket's subscriptions in O(paths) rather than
  // scanning every entry in `docSubscribers`.
  const socketDocPaths = new Map<WebSocket, Set<string>>();
  // Live cursor positions, per path. Not part of `docs.ts` — presence is a
  // WS-layer concern (who is looking at this file right now), not a CRDT one.
  const docPresence = new Map<string, Map<string, DocPresenceEntry>>();

  /** Send `frame` to every socket subscribed to `path`, skipping `exclude`
   *  (typically the frame's own origin, which already has this state). Mirrors
   *  `broadcast()` below but scoped to one document's subscribers instead of
   *  the whole room — the entire reason `doc_open` exists as a frame at all
   *  (see wire.ts): a room with forty files must not fan every keystroke out
   *  to everyone. */
  function docBroadcastFrame(path: string, frame: ServerFrame, exclude?: WebSocket): void {
    const subs = docSubscribers.get(path);
    if (subs === undefined) return;
    const payload = JSON.stringify(frame);
    for (const socket of subs) {
      if (socket === exclude) continue;
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  /** Remove `participantId`'s presence entry from `path`, returning the
   *  remaining roster to broadcast — or `null` when there was nothing to
   *  remove, so the caller can skip a pointless broadcast. */
  function clearPresenceEntry(path: string, participantId: string): DocPresenceEntry[] | null {
    const entries = docPresence.get(path);
    if (entries === undefined || !entries.has(participantId)) return null;
    entries.delete(participantId);
      // Prune the path entry once its last cursor is gone, mirroring
      // `docSubscribers` beside it. Without this the map only ever grows: a
      // room that opens forty files over an hour keeps forty empty Maps
      // forever. Found by the final audit.
      if (entries.size === 0) docPresence.delete(path);
    return [...entries.values()];
  }

  /**
   * ONE approval queue per room, shared by every agent's gate — which is the
   * whole point. The governance cap phase 12 needs is "how many agents may be
   * simultaneously blocked on a HUMAN", and a human is a property of the room,
   * not of an agent. A per-agent queue would let twenty agents each surface
   * their own request and reproduce exactly the wall of cards this exists to
   * prevent.
   */
  const approvals: ApprovalQueue = createApprovalQueue();

  const docs: DocRegistry = createDocRegistry(
    // Only `doc_snapshot` and `file_edited` ever reach this — see docs.ts's
    // own `EmitFn` comment. Routed through `commitAs` when the event already
    // carries an agentId (an agent's own whole-file write) and `commit`
    // (the primary agent) otherwise, the same split `resolvePermission`
    // above and every WS frame branch below already use.
    (event) => {
      const agentId = (event as { agentId?: AgentId }).agentId;
      if (agentId !== undefined) runtime.commitAs(agentId, event);
      else runtime.commit(event);
    },
    {
      // Fires for an agent's own whole-file write or an external
      // reconciliation (see the watcher hook below) — neither call site in
      // docs.ts hands this callback an attributable id (see `DOC_SYNC_NO_ORIGIN`'s
      // comment), so every out-of-band sync goes out under that sentinel.
      broadcastSync: (_room, path, payloadBase64) => {
        docBroadcastFrame(path, {
          kind: 'doc_sync',
          path,
          payload: payloadBase64,
          from: DOC_SYNC_NO_ORIGIN,
        });
      },
    },
  );

  const runtime: RoomRuntime = {
    room,
    sink,
    approvals,
    agents,
    get agent(): AgentHandle {
      const primary = agents.get(PRIMARY_AGENT_ID);
      if (primary === undefined) {
        // Was `as AgentHandle`, which typed away a genuinely reachable
        // undefined: attachAgent only sets the map entry AFTER startAgent
        // returns, so a synchronous throw in startAgent left a runtime whose
        // primary agent was missing, and the next request died with an opaque
        // "cannot read properties of undefined" 500. Name the condition instead.
        throw new Error(`Room ${room.id} has no primary agent attached.`);
      }
      return primary;
    },
    getAgent(agentId: AgentId = PRIMARY_AGENT_ID): AgentHandle | undefined {
      return agents.get(agentId);
    },
    // Constructs through `createRuntime` (phase 10) rather than calling
    // `startAgent` directly, so a room that ever names `openai`/`google` gets
    // a real adapter instead of silently spending the room's Anthropic key —
    // `createRuntime`'s own exhaustiveness check is what makes that a compile
    // error rather than a runtime guess. `provider` defaults to `'anthropic'`
    // so every existing caller (none of which name one) is unaffected
    // byte-for-byte: `createRuntime({provider: 'anthropic', ...})` calls
    // `startAgent` with the exact same three arguments this used to pass it
    // directly.
    attachAgent(agentId: AgentId, agentDeps: AgentDeps = {}, provider: AgentProvider = 'anthropic'): AgentHandle {
      const already = agents.get(agentId);
      if (already !== undefined) return already; // I1, per agent.
      const handle = createRuntime({
        provider,
        room,
        emit: (event) => runtime.commitAs(agentId, event),
        deps: {
          readEvents: () => sink.read(),
          // Bound per agent so the queue can attribute a waiting request to
          // the agent that is blocked on it — `agentId` is captured here, not
          // read off the request, because the gate has no idea which agent it
          // belongs to.
          visibility: {
            admit: (requestId, toolName, surface) =>
              approvals.admit(agentId, requestId, toolName, surface),
            release: (requestId) => approvals.release(requestId),
          },
          /**
           * The sibling roster (phase 17d). Bound per agent, for the same
           * reason `visibility` above is: the roster an agent is shown is
           * "everyone EXCEPT me", so it can only be built once `agentId` is
           * known.
           *
           * A FUNCTION, not a value, and deliberately not memoized. `agent.ts`
           * calls it fresh at every turn boundary because the fleet changes
           * underneath a long-lived session — I1 means this agent's `query()`
           * lives as long as the room does, so anything captured here at
           * construction time would describe the room as it was the moment
           * this agent spawned and never again.
           *
           * This line is the ENTIRE production path for phase 17d. Without it
           * `buildRosterView` is unreachable code with a full test suite of
           * its own: the unit that wrote it did not own this file, stopped at
           * the boundary, and said so in its report. A dep that is merely
           * present is not the same as a dep that is wired — an integration
           * test (`roster-wiring.test.ts`) asserts on the text an agent is
           * actually handed, not on whether this property exists.
           */
          roster: () => buildRosterView(runtime, agentId),
          ...deps,
          ...agentDeps,
        },
      });
      agents.set(agentId, handle);
      // `agent_spawned` makes the fleet derivable from the log alone (I3) —
      // but only the FIRST time this id is ever seen. The loop near the
      // bottom of this function calls `attachAgent` for every id
      // `projectAgents` finds on EVERY room attach, including a restart
      // recovering a room that already has history; that is a reattach, not
      // a spawn, and logging a fresh `agent_spawned` on every one of those
      // would mean a room surviving N restarts carries N duplicate entries
      // for the same agent forever — the log is append-only and can never
      // take a bad one back (I3). An id with no prior event of ANY kind is
      // genuinely new; `agentIdOf` already reads an absent `agentId` as the
      // primary agent (the v1 convention), so this same check correctly
      // recognises a v1 log's `room_created`/`participant_joined`/etc. as
      // prior history for the primary agent and skips re-spawning it.
      const seenBefore = sink
        .read()
        .some((event) => agentIdOf(event as { agentId?: AgentId }) === agentId);
      if (!seenBefore) {
        runtime.commitAs(agentId, {
          type: 'agent_spawned',
          provider,
          model: null,
          displayName: agentId === PRIMARY_AGENT_ID ? 'Agent' : agentId,
          participantId: null,
          spawnedByName: null,
        });
      }
      return handle;
    },
    workspaceWatcher: undefined as unknown as WorkspaceWatcherHandle,
    docs,
    async docOpen(socket: WebSocket, participantId: string, path: string): Promise<void> {
      const { payload } = await docs.open(room, path, participantId);
      let subs = docSubscribers.get(path);
      if (subs === undefined) {
        subs = new Set();
        docSubscribers.set(path, subs);
      }
      subs.add(socket);
      let paths = socketDocPaths.get(socket);
      if (paths === undefined) {
        paths = new Set();
        socketDocPaths.set(socket, paths);
      }
      paths.add(path);
      // Direct to this socket alone — every other subscriber already has
      // whatever history this payload carries.
      socket.send(
        JSON.stringify({
          kind: 'doc_sync',
          path,
          payload,
          from: DOC_SYNC_NO_ORIGIN,
        } satisfies ServerFrame),
      );
    },
    docClose(socket: WebSocket, participantId: string, path: string): void {
      docs.close(room, path, participantId);
      const subs = docSubscribers.get(path);
      subs?.delete(socket);
      if (subs !== undefined && subs.size === 0) docSubscribers.delete(path);
      socketDocPaths.get(socket)?.delete(path);
      const remaining = clearPresenceEntry(path, participantId);
      if (remaining !== null) {
        docBroadcastFrame(path, { kind: 'doc_presence', path, entries: remaining });
      }
    },
    async docApplySync(
      socket: WebSocket,
      participantId: string,
      path: string,
      payloadBase64: string,
    ): Promise<void> {
      const { broadcast } = await docs.applySync(room, path, payloadBase64, participantId);
      if (broadcast !== null) {
        // Never back to `socket` — it already applied this change locally
        // before sending it, which is what `applySync`'s own "broadcast to
        // every OTHER peer" contract (docs.ts) means here.
        docBroadcastFrame(path, { kind: 'doc_sync', path, payload: broadcast, from: participantId }, socket);
      }
    },
    docSetPresence(
      socket: WebSocket,
      participantId: string,
      displayName: string,
      path: string,
      anchor: number,
      head: number,
    ): void {
      let entries = docPresence.get(path);
      if (entries === undefined) {
        entries = new Map();
        docPresence.set(path, entries);
      }
      entries.set(participantId, { participantId, displayName, anchor, head });
      // Broadcast to EVERY subscriber, `socket` included — a second tab from
      // the same person should see its own entry reflected back too.
      docBroadcastFrame(path, { kind: 'doc_presence', path, entries: [...entries.values()] });
    },
    docDisconnect(socket: WebSocket, participantId: string): void {
      const paths = socketDocPaths.get(socket);
      if (paths === undefined) return;
      socketDocPaths.delete(socket);
      for (const path of paths) {
        // NOTE: if this same participant has a second socket with `path`
        // open (two tabs on one file), this releases their ONE shared
        // `peers` entry in `docs.ts` and clears their presence row even
        // though the other tab is still there. Tracking a per-socket
        // reference count would fix it; not done here — real usage is
        // overwhelmingly one tab per person per file, and `docs.ts`'s own
        // `peers` set does not currently gate anything (see its module
        // comment: flushing is decided by the `dirty` flag alone), so the
        // only visible cost today is a cursor that vanishes a beat early.
        docs.close(room, path, participantId);
        const subs = docSubscribers.get(path);
        subs?.delete(socket);
        if (subs !== undefined && subs.size === 0) docSubscribers.delete(path);
        const remaining = clearPresenceEntry(path, participantId);
        if (remaining !== null) {
          docBroadcastFrame(path, { kind: 'doc_presence', path, entries: remaining });
        }
      }
    },
    broadcast(frame: ServerFrame): void {
      const payload = JSON.stringify(frame);
      for (const socket of sockets.keys()) {
        if (socket.readyState === socket.OPEN) socket.send(payload);
      }
    },
    /**
     * Liveness, never membership. The fleet's MEMBERSHIP is derivable from the
     * log (`agent_spawned` / `agent_stopped`) and survives a restart; what is
     * not derivable is what each agent is doing this second, which is exactly
     * the role `connected` plays for a human on `PresenceEntry`. So this frame
     * is transient and unlogged, like `presence` beside it.
     */
    broadcastFleet(): void {
      runtime.broadcast({ kind: 'fleet', agents: fleetSnapshot(runtime) });
    },
    commit(event: UnsequencedEvent): NexusEvent {
      return runtime.commitAs(PRIMARY_AGENT_ID, event);
    },
    commitAs(agentId: AgentId, event: UnsequencedEvent): NexusEvent {
      // Redact ONCE, here, and use that single object for all three
      // destinations. Previously the sink redacted into a new object while the
      // broadcast — and the return value — still carried the original, so a
      // secret was scrubbed from disk and sent verbatim to every attached
      // browser in the same call. Replay looked clean, which is exactly why no
      // replay-based test ever caught it (I4).
      //
      // The sink redacts again. That is deliberate: redaction is idempotent
      // (`[REDACTED]` contains no pattern, and slicing twice is a no-op), and
      // keeping it there preserves the write-boundary guarantee for callers
      // that reach the log directly, such as recovery.ts.
      // The primary agent is deliberately left UNSTAMPED. `agentIdOf()` already
      // reads an absent agentId as the primary agent, so stamping it would add
      // a field to every event in every single-agent room for no information
      // gain — and would make new logs gratuitously different from the v1 logs
      // already on the production volume. Zero log churn until a room actually
      // has a second agent.
      // Any agentId riding in on the caller's event is STRIPPED first, then the
      // server's own is applied. The earlier form conditionally spread
      // `{...event, ...(primary ? {} : {agentId})}`, which spread nothing on the
      // primary branch and so let a caller-supplied agentId survive untouched —
      // the stamp was authoritative only for non-primary agents while this
      // method claimed it was unforgeable (I2'). Stripping first makes it
      // authoritative on both branches, and the primary agent still writes no
      // agentId key at all, so a single-agent log stays byte-identical to v1.
      const { agentId: _clientSupplied, ...unattributed } = event as { agentId?: AgentId };
      const sealed = redactEvent({
        ...unattributed,
        ...(agentId === PRIMARY_AGENT_ID ? {} : { agentId }),
        seq: room.nextSeq(),
        ts: new Date().toISOString(),
        roomId: room.id,
      } as NexusEvent);
      sink.append(sealed);
      runtime.broadcast({ kind: 'event', event: sealed });
      return sealed;
    },
    resolvePermission(requestId: string, decision: Decision, agentId?: AgentId): ResolveOutcome {
      if (agentId !== undefined) {
        const handle = agents.get(agentId);
        if (handle === undefined) return 'unknown-agent';
        return handle.gate.resolve(requestId, decision) ? 'settled' : 'not-found';
      }
      for (const handle of agents.values()) {
        if (handle.gate.resolve(requestId, decision)) return 'settled';
      }
      return 'not-found';
    },
    addSocket(socket: WebSocket, participantId: string): void {
      sockets.set(socket, participantId);
      room.sockets.add(socket);
    },
    removeSocket(socket: WebSocket): void {
      sockets.delete(socket);
      room.sockets.delete(socket);
    },
    socketCount(): number {
      return sockets.size;
    },
    participantSocketCount(participantId: string): number {
      let count = 0;
      for (const id of sockets.values()) if (id === participantId) count += 1;
      return count;
    },
  };

  // `readEvents` is threaded in here because this is the only place that holds
  // the sink. The publish tool uses it to find the room's own last published
  // commit from the log rather than from memory (I3) — which is what lets a
  // restarted room keep publishing to the same pull request.
  // Every agent this room has ever had, derived from the log alone (I3) — not
  // just the primary one. Today that list is always exactly [primary], because
  // nothing yet creates a second agent; wiring it now is what makes restart
  // recovery actually rebuild a roster rather than merely being able to, and
  // stops `projectAgents` from being a function with a docstring and no caller.
  for (const agentId of projectAgents(sink.read())) {
    runtime.attachAgent(agentId);
  }
  // Lives inside this memoized gate for the same reason the agent does: the
  // `existing !== undefined` early return above is what guarantees a room
  // cannot accumulate N watchers (I1's one-resource discipline, applied to a
  // second resource). `workspace_changed` is transient and unlogged — see the
  // comment on `ServerFrame` in `packages/protocol/src/wire.ts` — so it goes straight
  // to broadcast() and nowhere near commit().
  runtime.workspaceWatcher = startWorkspaceWatcher(room, (paths, truncated) => {
    runtime.broadcast({ kind: 'workspace_changed', paths, truncated });
    // Phase 11: a change from OUTSIDE the CRDT layer — a shell command, a git
    // checkout, a formatter — to a path someone has open as a collaborative
    // document must reach that document too, or the CRDT and disk silently
    // diverge until something else forces a reconcile. Gated on
    // `docSubscribers`, this room's own record of which paths currently have
    // a live subscriber, rather than attempting every changed path: reading
    // and diffing a file nobody has open would be pure waste on every watcher
    // tick for the overwhelming majority of a repository.
    for (const path of paths) {
      if (!docSubscribers.has(path)) continue;
      try {
        const read = readWorkspaceFile(room, path);
        if (read.kind !== 'text') continue; // binary / too_large: nothing a CRDT can merge
        void docs.reconcileExternal(room, path, read.content).catch(() => {
          // Never let a reconciliation failure take down the watcher's own
          // callback — the next external change (or the next flush cycle)
          // gets another chance.
        });
      } catch {
        // Deleted, or escaped the jail since the watcher fired — nothing to
        // reconcile into.
      }
    }
  });
  runtimes.set(room.id, runtime);
  // A room recovered from disk (plan phase-3a) already has `room_created` in
  // its log. Committing a second one on every re-key would permanently pollute
  // the history — the log is append-only, so a duplicate can never be removed.
  if (!sink.read().some((event) => event.type === 'room_created')) {
    runtime.commit({
      type: 'room_created',
      cwd: room.cwd,
      repoUrl: room.repoUrl,
      github: room.github,
    });
  }
  return runtime;
}

export function getRuntime(roomId: string): RoomRuntime | undefined {
  return runtimes.get(roomId);
}

export function newParticipantId(): string {
  return `p_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/** Shape of ids this server mints. A reclaim attempt must match it. */
const PARTICIPANT_ID_PATTERN = /^p_[0-9a-f]{12}$/;

/**
 * Secrets that let a returning socket prove it is the same participant.
 * Per room, never logged, never broadcast, never persisted — losing them on
 * restart is correct, because a recovered room's roster is empty anyway.
 */
const resumeTokens = new WeakMap<Room, Map<string, string>>();

function tokensFor(room: Room): Map<string, string> {
  const existing = resumeTokens.get(room);
  if (existing !== undefined) return existing;
  const created = new Map<string, string>();
  resumeTokens.set(room, created);
  return created;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Decide who an incoming socket is.
 *
 * A reconnecting client may offer back the id it was given plus the resume
 * token that came with it. All three must line up — the id must still be on
 * the roster, the token must match, and the display name must be the same one
 * that id already belongs to. Anything else — absent, malformed, unknown, bad
 * token, different name — mints a fresh identity, which is exactly the old
 * behaviour.
 *
 * The token matters: participant ids are broadcast to the whole room inside
 * `participant_joined`, so honouring a bare id would let any member reconnect
 * as the current driver and inherit the token. That is an I2 bypass at the
 * server, which is the one place I2 is supposed to hold. Identity is therefore
 * a capability you hold, not a name you can read off the log.
 *
 * The name matters for a subtler reason, found by opening two tabs in one
 * browser: tabs share localStorage, so the second person to open a room link
 * on a shared machine offers back the first person's stored identity holding a
 * perfectly valid token. The token proves "same browser storage", not "same
 * person" — without this check the two collapse into one roster row whose name
 * flips between them, and the second inherits the first's driver token.
 */
export function resolveParticipantId(
  room: Room,
  requestedId: string | null,
  resumeToken: string | null,
  displayName: string,
): { participantId: string; resumeToken: string } {
  const tokens = tokensFor(room);

  if (
    requestedId !== null &&
    resumeToken !== null &&
    PARTICIPANT_ID_PATTERN.test(requestedId) &&
    room.participants.get(requestedId)?.displayName === displayName
  ) {
    const expected = tokens.get(requestedId);
    if (expected !== undefined && safeEqual(expected, resumeToken)) {
      return { participantId: requestedId, resumeToken: expected };
    }
  }

  const participantId = newParticipantId();
  const issued = randomBytes(32).toString('hex');
  tokens.set(participantId, issued);
  return { participantId, resumeToken: issued };
}

/**
 * Test-only. Never call from server code.
 *
 * Disposes each room's document registry before dropping it — the closest
 * thing to "torn down" this codebase has (there is still no production
 * room-teardown path; see `workspaceWatcher`'s own comment above, which has
 * the same gap and for the same reason). Without this, a test suite that
 * calls `attachRoom` repeatedly leaks one set of live flush timers per room
 * for the lifetime of the process.
 */
export function __resetRuntimes(): void {
  for (const runtime of runtimes.values()) runtime.docs.disposeRoom(runtime.room.id);
  runtimes.clear();
}
