import type { NexusEvent } from '@nexus/protocol/events';
import type { FleetEntry, PresenceEntry, ServerFrame } from '@nexus/protocol/wire';

export interface Message {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'system';
  author: string | null;
  text: string;
  seq: number;
  /**
   * Set only on user prompts, and only when the log says so. Optional on the
   * wire (logs predating phase 4 lack it), so `undefined` means "unknown" and
   * must not be rendered as "was not driving".
   */
  wasDriver?: boolean;
}

export interface RoomView {
  messages: Message[];
  participants: PresenceEntry[];
  driverId: string | null;
  /** This client's own participant id, learned from `replay_complete`. */
  selfId: string | null;
  /**
   * Every logged event, in order, exactly as it arrived. Features that project
   * their own state off the log — pending approvals in phase-2d, and anything
   * later — read this instead of growing a parallel store of their own, which
   * would put a second source of truth beside the log and violate I3.
   * Deduplicated by the same `seq` guard as the rest of the reducer.
   */
  events: NexusEvent[];
  lastSeq: number;
  replaying: boolean;
  /** messageId -> accumulated streaming text. Never logged, never replayed. */
  pendingDeltas: Record<string, string>;
  /**
   * Text of the most recent transient `error` frame. Not a logged event, so it
   * carries no seq and never survives a replay.
   */
  lastError: string | null;
  /**
   * How many error frames have arrived. A dismissable banner needs this: the
   * same message repeats constantly ("You are not driving"), and comparing
   * message text alone would swallow every repeat after the first dismissal.
   */
  errorCount: number;
  /**
   * The most recent set of paths the server's watcher saw change OUTSIDE the
   * agent — a shell command, a `git checkout`, a formatter — with a nonce that
   * advances on every frame.
   *
   * Transient, like `pendingDeltas` and `lastError`: it carries no seq, is never
   * logged and never survives a replay. The nonce is not decoration. A formatter
   * rewriting one file reports the identical path list each time, so comparing
   * paths alone would read every change after the first as "nothing happened" —
   * the same trap `errorCount` above already exists to avoid.
   */
  externalChanges: { paths: string[]; nonce: number };
  /**
   * Live status for every agent in the room's fleet.
   *
   * Held here, beside `participants`, because it is the same KIND of thing: a
   * transient snapshot of who is present and what they are doing, pushed whole
   * on every change rather than accumulated. Fleet MEMBERSHIP is derivable from
   * the log (`agent_spawned` / `agent_stopped`) and any component may derive it
   * from `events`; what cannot be derived is whether an agent is mid-turn right
   * now, which is precisely what `connected` is for a human.
   */
  fleet: FleetEntry[];
}

export const EMPTY_VIEW: RoomView = {
  messages: [],
  participants: [],
  driverId: null,
  selfId: null,
  events: [],
  lastSeq: 0,
  replaying: true,
  pendingDeltas: {},
  lastError: null,
  errorCount: 0,
  externalChanges: { paths: [], nonce: 0 },
  fleet: [],
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
      return {
        ...view,
        replaying: false,
        lastSeq: Math.max(view.lastSeq, frame.lastSeq),
        selfId: frame.participantId,
      };
    case 'presence':
      return { ...view, participants: frame.participants, driverId: frame.driverId };
    case 'error':
      return { ...view, lastError: frame.message, errorCount: view.errorCount + 1 };
    case 'event':
      // A reconnect may resend events we already folded in. Ignore them. The
      // raw event is retained here, in the one place that already knows an
      // event is new, so `events` can never drift from the reduced view.
      return frame.event.seq <= view.lastSeq
        ? view
        : applyEvent({ ...view, events: [...view.events, frame.event] }, frame.event);
    case 'workspace_changed':
      // Consumed, at last. The server has always broadcast this (`ws.ts:257`)
      // and the protocol has always declared it (`wire.ts:41-49`), but no client
      // code read it, so an edit Nexus did not make never reached the pane.
      //
      // Deliberately does NOT refetch anything. Staleness and refetching belong
      // to `useWorkspace`, which owns the file cache; this reducer's only job is
      // to make the fact visible in the view that every component already reads.
      return {
        ...view,
        externalChanges: { paths: frame.paths, nonce: view.externalChanges.nonce + 1 },
      };
    case 'fleet':
      return { ...view, fleet: frame.agents };
    case 'doc_sync':
    case 'doc_presence':
      /**
       * Deliberately ignored HERE, and that is a routing decision rather than a
       * swallow — the distinction the exhaustiveness check below exists to
       * force someone to make out loud.
       *
       * Both frames are keystroke-rate. Folding them into this reducer would put
       * a CRDT sync stream into React state, so every character anyone typed in
       * any open file would re-render the transcript, the roster and the
       * approval queue. The document layer subscribes to the socket directly
       * instead, exactly as `useWorkspace` owns the file cache outside the
       * log-derived view — the room's state model stays a fold over the log, and
       * the editor's state model stays a CRDT.
       */
      return view;
    default: {
      // Compile-time exhaustiveness, runtime tolerance — deliberately both.
      //
      // Runtime: an older client may meet a newer server, so an unrecognised
      // frame must be IGNORED, never thrown on. That forward-compatibility is
      // why this branch returns `view` rather than asserting.
      //
      // Compile time: with every kind handled above, `frame` narrows to `never`
      // here. Add a member to `ServerFrame` and this assignment stops compiling,
      // which is the only thing that forces a new frame to be handled rather
      // than silently swallowed by this branch. An adversarial review of the
      // 11b design found the plan relying on a forcing function that did not
      // exist yet — a `doc_sync` frame would have vanished here with a green
      // suite, a green typecheck and no runtime complaint.
      const unhandled: never = frame;
      void unhandled;
      return view;
    }
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
        // `=== true`, never a truthy check: the field is optional, and an
        // absent one means unknown rather than false.
        ...(event.wasDriver === true ? { wasDriver: true } : {}),
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
        text:
          event.github == null
            ? `Room opened in ${event.cwd}`
            : `Room opened on ${event.github.owner}/${event.github.repo} (${event.github.defaultBranch})`,
        seq: event.seq,
      });

    case 'github_published':
      return push(next, {
        id: `e${event.seq}`,
        kind: 'system',
        author: null,
        text:
          `${event.created ? 'Opened' : 'Updated'} pull request #${event.prNumber} ` +
          `— ${event.filesChanged} file${event.filesChanged === 1 ? '' : 's'} changed: ${event.prUrl}`,
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

    case 'prompt_batch_delivered':
      // Deliberately produces no transcript line. Every turn emits one, and the
      // prompts it names are already rendered as user messages — a row per
      // batch would be noise. Its job is to retire prompts from the queued list
      // in PendingPrompts, which reads `events` directly.
      return next;

    case 'prompt_batch_discarded':
      return push(next, {
        id: `e${event.seq}`,
        kind: 'system',
        author: null,
        text:
          `${event.byDisplayName} stopped the agent — ` +
          `${event.promptSeqs.length} queued prompt${event.promptSeqs.length === 1 ? '' : 's'} ` +
          'were not sent.',
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
