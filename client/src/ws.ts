import type { ClientFrame, ServerFrame } from '../../src/protocol/wire.js';
import { EMPTY_VIEW, reduce } from './store.js';
import type { RoomView } from './store.js';

export type Status = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface ConnectOptions {
  roomId: string;
  token: string;
  displayName: string;
  onView(view: RoomView): void;
  onStatus(status: Status): void;
  socketFactory?: (url: string) => WebSocketLike;
  baseUrl?: string;
}

export interface Connection {
  send(frame: ClientFrame): void;
  close(): void;
}

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

export function buildUrl(options: {
  baseUrl?: string;
  roomId: string;
  token: string;
  displayName: string;
  since: number;
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
  return `${base}/ws?${params.toString()}`;
}

export function connect(options: ConnectOptions): Connection {
  const makeSocket =
    options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);

  let view: RoomView = EMPTY_VIEW;
  let socket: WebSocketLike | null = null;
  let attempt = 0;
  let deliberatelyClosed = false;

  function open(): void {
    options.onStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    const url = buildUrl({
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      roomId: options.roomId,
      token: options.token,
      displayName: options.displayName,
      since: view.lastSeq,
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
      view = reduce(view, frame);
      options.onView(view);
    };

    next.onclose = () => {
      if (deliberatelyClosed) {
        options.onStatus('closed');
        return;
      }
      options.onStatus('reconnecting');
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 8_000;
      attempt += 1;
      setTimeout(open, delay);
    };
  }

  open();

  return {
    send(frame: ClientFrame): void {
      socket?.send(JSON.stringify(frame));
    },
    close(): void {
      deliberatelyClosed = true;
      socket?.close();
    },
  };
}
