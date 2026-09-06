import type { ClientFrame, ServerFrame } from '@nexus/protocol/wire';
import { EMPTY_VIEW, reduce } from './store.js';
import type { RoomView } from './store.js';
import { createDocSession } from './workspace/docSession.js';
import type { DocSession } from './workspace/docSession.js';

export type Status = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  /** The browser passes a CloseEvent; tests may call it with nothing. */
  onclose: ((event?: { code?: number }) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface ConnectOptions {
  roomId: string;
  token: string;
  displayName: string;
  onView(view: RoomView): void;
  onStatus(status: Status): void;
  /**
   * Fired exactly once per `connect()` call, the moment this connection's
   * `DocSession` becomes available. Not synchronous with `connect()` itself:
   * a `DocSession` needs this client's own participant id (to recognise its
   * own edits echoed back — see `docSession.ts`), which is only known once
   * the server's `replay_complete` frame arrives, so the session is created
   * lazily at that point and handed back through this callback rather than a
   * return value the caller would otherwise have to treat as possibly absent
   * forever.
   */
  onDocSession?(session: DocSession): void;
  socketFactory?: (url: string) => WebSocketLike;
  baseUrl?: string;
}

export interface Connection {
  send(frame: ClientFrame): void;
  close(): void;
}

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

/**
 * Close codes the server uses for "this connection is not allowed", as
 * opposed to "the network blipped". Retrying these forever accomplishes
 * nothing but noise: a bad room token never becomes good, and a recovered
 * room stays keyless until a human re-supplies the key.
 */
const TERMINAL_CLOSE_CODES = new Set([4401, 4409]);

/**
 * Scoped per room AND per display name. Two rooms open in one browser must not
 * share an identity — and neither must two people on one machine, who share
 * localStorage and would otherwise hand each other a valid resume token for
 * the same participant. The server rejects a mismatched name anyway; this
 * keeps the client from making a pointless reclaim attempt in the first place.
 */
function identityKey(roomId: string, displayName: string): string {
  return `nexus:identity:${roomId}:${displayName}`;
}

interface StoredIdentity {
  participantId: string;
  resumeToken: string;
}

function readIdentity(roomId: string, displayName: string): StoredIdentity | null {
  try {
    const raw = globalThis.localStorage?.getItem(identityKey(roomId, displayName));
    if (raw === null || raw === undefined) return null;
    const parsed = JSON.parse(raw) as Partial<StoredIdentity>;
    return typeof parsed.participantId === 'string' && typeof parsed.resumeToken === 'string'
      ? { participantId: parsed.participantId, resumeToken: parsed.resumeToken }
      : null;
  } catch {
    // Private mode, disabled storage, or corrupt JSON. A fresh identity is a
    // correct fallback, never an error.
    return null;
  }
}

function writeIdentity(roomId: string, displayName: string, identity: StoredIdentity): void {
  try {
    globalThis.localStorage?.setItem(identityKey(roomId, displayName), JSON.stringify(identity));
  } catch {
    // Storage unavailable: the session still works, it just will not survive
    // a reload. Never surface this to the user.
  }
}

export function buildUrl(options: {
  baseUrl?: string;
  roomId: string;
  token: string;
  displayName: string;
  since: number;
  participantId?: string | null;
  resumeToken?: string | null;
}): string {
  const base =
    options.baseUrl ??
    `${globalThis.location.protocol === 'https:' ? 'wss' : 'ws'}://${globalThis.location.host}`;
  const params = new URLSearchParams({
    room: options.roomId,
    token: options.token,
    name: options.displayName,
    since: String(options.since),
  });
  // Both or neither — an id without its token is not a reclaim, and the
  // server would only mint a fresh identity anyway.
  if (
    options.participantId !== null &&
    options.participantId !== undefined &&
    options.resumeToken !== null &&
    options.resumeToken !== undefined
  ) {
    params.set('participant', options.participantId);
    params.set('resume', options.resumeToken);
  }
  return `${base}/ws?${params.toString()}`;
}

export function connect(options: ConnectOptions): Connection {
  const makeSocket =
    options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);

  let view: RoomView = EMPTY_VIEW;
  let socket: WebSocketLike | null = null;
  let attempt = 0;
  let deliberatelyClosed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let identity: StoredIdentity | null = readIdentity(options.roomId, options.displayName);
  /**
   * Created ONCE per `connect()` call (this whole function's lifetime), not
   * once per underlying socket — a reconnect must not throw away in-progress
   * local edits or reopen every document from scratch. `send` below always
   * goes through the live `socket` variable rather than a closure captured at
   * construction time, so the same session keeps working across a reconnect
   * without having to be told about the new socket.
   */
  let docSession: DocSession | null = null;

  function open(): void {
    options.onStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    const url = buildUrl({
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      roomId: options.roomId,
      token: options.token,
      displayName: options.displayName,
      since: view.lastSeq,
      participantId: identity?.participantId ?? null,
      resumeToken: identity?.resumeToken ?? null,
    });
    const next = makeSocket(url);
    socket = next;

    next.onopen = () => {
      attempt = 0;
      options.onStatus('open');
    };

    next.onmessage = (message) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(message.data)) as ServerFrame;
      } catch {
        return;
      }
      // Remember who the server says we are, so a refresh keeps this roster
      // row and — if we hold it — the driver token. Read off the raw frame
      // rather than the reduced view: the resume token is a transient secret
      // and deliberately never enters RoomView.
      if (frame.kind === 'replay_complete') {
        identity = { participantId: frame.participantId, resumeToken: frame.resumeToken };
        writeIdentity(options.roomId, options.displayName, identity);
        // The session needs this client's OWN participant id at construction
        // (to recognise its own edits echoed back — `docSession.ts`'s own
        // comment on why `selfId` is a plain string, captured once, rather
        // than a live accessor), which is only known from this exact frame.
        // Guarded so a reconnect's second `replay_complete` reuses the
        // existing session instead of replacing it and losing whatever it
        // holds locally.
        if (docSession === null) {
          docSession = createDocSession((f) => socket?.send(JSON.stringify(f)), frame.participantId);
          options.onDocSession?.(docSession);
        }
      }
      // Give the document layer first look at every frame, exactly as
      // `docSession.ts`'s own module comment describes: `doc_sync` /
      // `doc_presence` are keystroke-rate, and folding them into the room
      // reducer would re-render the transcript, the roster and the approval
      // queue on every character anyone types in any open file. `replay_complete`
      // itself is handled just above and ALSO falls through to `reduce` below
      // (`handleFrame` returns false for it), so `view.selfId` still gets set
      // the normal way.
      if (docSession !== null && docSession.handleFrame(frame)) return;
      view = reduce(view, frame);
      options.onView(view);
    };

    next.onclose = (event) => {
      socket = null;
      if (deliberatelyClosed) {
        // close() already drives the terminal status and clears any
        // pending reconnect timer — nothing more to do here. Guarding
        // here (rather than relying solely on close() cancelling the
        // timer) keeps this handler a no-op no matter how the underlying
        // socket implementation behaves on an already-closed connection.
        return;
      }
      const code = event?.code;
      if (code !== undefined && TERMINAL_CLOSE_CODES.has(code)) {
        options.onStatus('closed');
        return;
      }
      options.onStatus('reconnecting');
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 8_000;
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        open();
      }, delay);
    };
  }

  open();

  return {
    send(frame: ClientFrame): void {
      socket?.send(JSON.stringify(frame));
    },
    close(): void {
      deliberatelyClosed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      docSession?.dispose();
      socket?.close();
      socket = null;
      options.onStatus('closed');
    },
  };
}
