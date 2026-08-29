import type { NexusEvent, UserPrompt } from '@nexus/protocol/events';

export interface PendingPrompt {
  seq: number;
  displayName: string;
  text: string;
  wasDriver: boolean | null;
  /** Discarded prompts are shown too, with a resend, rather than vanishing. */
  status: 'queued' | 'discarded';
}

/**
 * Derived straight from the raw event log (I3), the same shape as
 * `deriveApprovals` in App.tsx and `InterruptNotice` — no second store beside
 * `view.events`, which would put a rival source of truth next to the log.
 *
 * A prompt is queued until some batch event names its seq. Delivered prompts
 * disappear from here because they are already in the transcript; discarded
 * ones stay visible, because the alternative is text silently evaporating
 * after someone else pressed Stop.
 */
export function derivePending(events: NexusEvent[]): PendingPrompt[] {
  const prompts = new Map<number, UserPrompt>();
  const discarded = new Set<number>();
  const settled = new Set<number>();

  for (const event of events) {
    if (event.type === 'user_prompt') prompts.set(event.seq, event);
    if (event.type === 'prompt_batch_delivered') {
      for (const seq of event.promptSeqs) settled.add(seq);
    }
    if (event.type === 'prompt_batch_discarded') {
      for (const seq of event.promptSeqs) {
        settled.add(seq);
        discarded.add(seq);
      }
    }
  }

  const pending: PendingPrompt[] = [];
  for (const [seq, event] of prompts) {
    if (settled.has(seq) && !discarded.has(seq)) continue;
    pending.push({
      seq,
      displayName: event.displayName,
      text: event.text,
      // Optional on the wire: logs written before phase 4 have no such field,
      // and absent means "unknown", not false. Never truthy-check and assume.
      wasDriver: event.wasDriver === undefined ? null : event.wasDriver,
      status: discarded.has(seq) ? 'discarded' : 'queued',
    });
  }
  return pending.sort((a, b) => a.seq - b.seq);
}

export function PendingPrompts({
  events,
  onResend,
}: {
  events: NexusEvent[];
  onResend: (text: string) => void;
}): JSX.Element | null {
  const pending = derivePending(events);
  if (pending.length === 0) return null;

  return (
    <ul aria-label="Queued prompts" className="flex flex-col gap-1">
      {pending.map((prompt) => (
        <li
          key={prompt.seq}
          className={`flex items-center gap-2 rounded border px-2 py-1 text-xs ${
            prompt.status === 'discarded'
              ? 'border-danger bg-surface text-danger'
              : 'border-warn bg-surface text-warn'
          }`}
        >
          <span className="font-semibold">{prompt.displayName}</span>
          {prompt.wasDriver === true && <span className="text-[10px] uppercase">driver</span>}
          <span className="flex-1 truncate">{prompt.text}</span>
          {prompt.status === 'discarded' ? (
            <button
              type="button"
              className="rounded border border-danger px-2 py-0.5 font-medium text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              onClick={() => onResend(prompt.text)}
            >
              Resend
            </button>
          ) : (
            <span className="text-[10px] uppercase">queued</span>
          )}
        </li>
      ))}
    </ul>
  );
}
