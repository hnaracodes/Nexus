import { useEffect, useRef, useState } from 'react';
import type { NexusEvent } from '@nexus/protocol/events';
import { NexusBlob } from './NexusBlob.js';

/**
 * Nexus waves people in.
 *
 * The interesting constraint is *which* joins to celebrate. A room's log is
 * replayed in full on every connect, so the naive "render a toast per
 * participant_joined" fires a burst of six toasts the moment you open a room
 * that has had six people through it. Worse, a reconnect replays them again.
 *
 * So the first render establishes a high-water mark and celebrates nothing.
 * Only events with a sequence number above whatever we had already seen count
 * as "somebody just arrived" — which is also exactly the rule the transcript
 * uses, so the two never disagree about what is new.
 */

interface Welcome {
  id: string;
  name: string;
}

const VISIBLE_MS = 4200;

export function deriveJoinsAfter(events: NexusEvent[], afterSeq: number): Welcome[] {
  return events
    .filter(
      (event): event is Extract<NexusEvent, { type: 'participant_joined' }> =>
        event.type === 'participant_joined' && event.seq > afterSeq,
    )
    .map((event) => ({ id: `${event.seq}`, name: event.displayName }));
}

export function JoinToasts({
  events,
  selfId,
  replaying,
}: {
  events: NexusEvent[];
  selfId: string | null;
  /**
   * True until `replay_complete` lands. Load-bearing: without it the
   * high-water mark below is adopted on the first effect pass, when `events`
   * holds whatever handful of frames happened to arrive before React rendered
   * — and every remaining replayed join is then greeted as a new arrival.
   * Opening a room with a long history buried the UI under a column of toasts,
   * which is the exact thing this component's guard was written to prevent.
   */
  replaying: boolean;
}): JSX.Element | null {
  const [welcomes, setWelcomes] = useState<Welcome[]>([]);
  // -1 until the first render settles; then it is the highest seq we have
  // already accounted for. Initialised from a ref so replay never celebrates.
  const seenSeq = useRef<number | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    // Nothing is "new" until the history has finished arriving. A reconnect
    // sets this true again, which is harmless: `seenSeq` is already set by
    // then, and resent events carry seq values at or below it.
    if (replaying) return;

    const highest = events.reduce((max, event) => (event.seq > max ? event.seq : max), 0);

    if (seenSeq.current === null) {
      // First pass: adopt the whole replayed history as "already seen".
      seenSeq.current = highest;
      return;
    }
    if (highest <= seenSeq.current) return;

    const fresh = deriveJoinsAfter(events, seenSeq.current).filter(
      // Don't wave at yourself.
      (welcome) => welcome.id !== selfId,
    );
    seenSeq.current = highest;
    if (fresh.length === 0) return;

    setWelcomes((current) => [...current, ...fresh]);
    for (const welcome of fresh) {
      timers.current.push(
        setTimeout(() => {
          setWelcomes((current) => current.filter((item) => item.id !== welcome.id));
        }, VISIBLE_MS),
      );
    }
  }, [events, selfId, replaying]);

  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );

  if (welcomes.length === 0) return null;

  return (
    // aria-live polite rather than assertive: an arrival is worth announcing,
    // never worth interrupting someone mid-sentence to announce.
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2"
    >
      {welcomes.map((welcome) => (
        <div
          key={welcome.id}
          className="nexus-welcome flex items-center gap-2.5 rounded-full border border-border bg-surface/95 py-1.5 pl-1.5 pr-4 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.7)] backdrop-blur"
        >
          <NexusBlob size={34} waving />
          <span className="text-sm text-fg">
            <span className="font-semibold">{welcome.name}</span> joined the room
          </span>
        </div>
      ))}
    </div>
  );
}
