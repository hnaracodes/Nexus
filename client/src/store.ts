import type { NexusEvent } from '../../src/protocol/events.js';
import type { PresenceEntry, ServerFrame } from '../../src/protocol/wire.js';

export interface Message {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'system';
  author: string | null;
  text: string;
  seq: number;
}

export interface RoomView {
  messages: Message[];
  participants: PresenceEntry[];
  driverId: string | null;
  lastSeq: number;
  replaying: boolean;
  /** messageId -> accumulated streaming text. Never logged, never replayed. */
  pendingDeltas: Record<string, string>;
}

export const EMPTY_VIEW: RoomView = {
  messages: [],
  participants: [],
  driverId: null,
  lastSeq: 0,
  replaying: true,
  pendingDeltas: {},
};

export function reduce(view: RoomView, frame: ServerFrame): RoomView {
  switch (frame.kind) {
    case 'assistant_delta': {
      const previous = view.pendingDeltas[frame.messageId] ?? '';
      return {
        ...view,
        pendingDeltas: { ...view.pendingDeltas, [frame.messageId]: previous + frame.text },
      };
    }
    case 'replay_complete':
      return { ...view, replaying: false, lastSeq: Math.max(view.lastSeq, frame.lastSeq) };
    case 'presence':
      return { ...view, participants: frame.participants, driverId: frame.driverId };
    case 'error':
      return view;
    case 'event':
      // A reconnect may resend events we already folded in. Ignore them.
      return frame.event.seq <= view.lastSeq ? view : applyEvent(view, frame.event);
    default:
      return view;
  }
}

function applyEvent(view: RoomView, event: NexusEvent): RoomView {
  const next: RoomView = { ...view, lastSeq: event.seq };

  switch (event.type) {
    case 'user_prompt':
      return push(next, {
        id: `e${event.seq}`,
        kind: 'user',
        author: event.displayName,
        text: event.text,
        seq: event.seq,
      });

    case 'assistant_message': {
      const { [event.messageId]: _settled, ...rest } = next.pendingDeltas;
      return push(
        { ...next, pendingDeltas: rest },
        { id: event.messageId, kind: 'assistant', author: null, text: event.text, seq: event.seq },
      );
    }

    case 'tool_start':
      return push(next, {
        id: event.toolUseId,
        kind: 'tool',
        author: null,
        text: `${event.toolName} ${JSON.stringify(event.input)}`,
        seq: event.seq,
      });

    case 'tool_result':
      // Fold into the tool_start row so one call renders as one line.
      return {
        ...next,
        messages: next.messages.map((message) =>
          message.id === event.toolUseId
            ? { ...message, text: `${message.text}\n→ ${event.output}` }
            : message,
        ),
      };

    case 'participant_joined':
      return push(withParticipant(next, event.participantId, event.displayName, true), {
        id: `e${event.seq}`,
        kind: 'system',
        author: null,
        text: `${event.displayName} joined`,
        seq: event.seq,
      });

    case 'participant_left':
      return push(withParticipant(next, event.participantId, event.displayName, false), {
        id: `e${event.seq}`,
        kind: 'system',
        author: null,
        text: `${event.displayName} left`,
        seq: event.seq,
      });

    case 'driver_granted':
      return push(
        { ...next, driverId: event.participantId },
        {
          id: `e${event.seq}`,
          kind: 'system',
          author: null,
          text: `${event.displayName} is now driving`,
          seq: event.seq,
        },
      );

    case 'driver_released':
      return push(
        { ...next, driverId: null },
        {
          id: `e${event.seq}`,
          kind: 'system',
          author: null,
          text: `${event.displayName} released control`,
          seq: event.seq,
        },
      );

    case 'room_created':
      return push(next, {
        id: `e${event.seq}`,
        kind: 'system',
        author: null,
        text: `Room opened in ${event.cwd}`,
        seq: event.seq,
      });

    case 'agent_error':
      return push(next, {
        id: `e${event.seq}`,
        kind: 'system',
        author: null,
        text: event.message,
        seq: event.seq,
      });

    case 'agent_idle':
      return push(next, {
        id: `e${event.seq}`,
        kind: 'system',
        author: null,
        text: 'Agent idle',
        seq: event.seq,
      });

    default:
      // Permission and interrupt events render in phase-2d / phase-3b.
      return next;
  }
}

function push(view: RoomView, message: Message): RoomView {
  return { ...view, messages: [...view.messages, message] };
}

function withParticipant(
  view: RoomView,
  participantId: string,
  displayName: string,
  connected: boolean,
): RoomView {
  const existing = view.participants.some((p) => p.participantId === participantId);
  return {
    ...view,
    participants: existing
      ? view.participants.map((p) => (p.participantId === participantId ? { ...p, connected } : p))
      : [...view.participants, { participantId, displayName, connected }],
  };
}

export function project(frames: ServerFrame[]): RoomView {
  return frames.reduce(reduce, EMPTY_VIEW);
}
