import { useState } from 'react';
import type { SynCodeEvent, UserPrompt } from '@syncode/protocol/events';

export interface PendingPrompt {
  seq: number;
  displayName: string;
  text: string;
  wasDriver: boolean | null;
  participantId: string;
  /** For discarded prompts: the discard event (group key) and who pressed Stop. */
  discardSeq: number | null;
  discardedBy: string | null;
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
export function derivePending(events: SynCodeEvent[]): PendingPrompt[] {
  const prompts = new Map<number, UserPrompt>();
  const discarded = new Map<number, { seq: number; by: string }>();
  const settled = new Set<number>();

  for (const event of events) {
    if (event.type === 'user_prompt') prompts.set(event.seq, event);
    if (event.type === 'prompt_batch_delivered') {
      for (const seq of event.promptSeqs) settled.add(seq);
    }
    if (event.type === 'prompt_batch_discarded') {
      for (const seq of event.promptSeqs) {
        settled.add(seq);
        discarded.set(seq, { seq: event.seq, by: event.byDisplayName });
      }
    }
  }

  const pending: PendingPrompt[] = [];
  for (const [seq, event] of prompts) {
    if (settled.has(seq) && !discarded.has(seq)) continue;
    pending.push({
      seq,
      displayName: event.displayName,
      participantId: event.participantId,
      discardSeq: discarded.get(seq)?.seq ?? null,
      discardedBy: discarded.get(seq)?.by ?? null,
      text: event.text,
      // Optional on the wire: logs written before phase 4 have no such field,
      // and absent means "unknown", not false. Never truthy-check and assume.
      wasDriver: event.wasDriver === undefined ? null : event.wasDriver,
      status: discarded.has(seq) ? 'discarded' : 'queued',
    });
  }
  return pending.sort((a, b) => a.seq - b.seq);
}

const BTN =
  'rounded border px-1.5 py-0.5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg';
const BTN_DANGER = `${BTN} border-danger text-danger`;
const BTN_WARN = `${BTN} border-warn text-warn`;

/**
 * Local dismissals are view state only: the log is append-only (I3), so
 * nothing is sent anywhere. Keyed by prompt seq.
 */
export function PendingPrompts({
  events,
  onResend,
  onEdit,
  onSendNow,
  selfId,
}: {
  events: SynCodeEvent[];
  onResend: (text: string) => void;
  /** Puts the text back in the input. Button hidden when absent. */
  onEdit?: (text: string) => void;
  /** Shell implements as interrupt-then-resend. Offered only on the caller's own queued prompts. */
  onSendNow?: (texts: string[]) => void;
  /** The current user's participantId. */
  selfId?: string;
}): JSX.Element | null {
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(new Set());
  const pending = derivePending(events).filter((p) => !dismissed.has(p.seq));
  if (pending.length === 0) return null;

  const dismiss = (seqs: number[]): void =>
    setDismissed((prev) => new Set([...prev, ...seqs]));

  const queued = pending.filter((p) => p.status === 'queued');
  const groups = new Map<number, PendingPrompt[]>();
  for (const p of pending) {
    if (p.status !== 'discarded') continue;
    const key = p.discardSeq ?? -p.seq;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }

  return (
    <ul aria-label="Queued prompts" className="flex flex-col gap-1">
      {[...groups.entries()].map(([key, group]) => {
        const seqs = group.map((p) => p.seq);
        const first = group[0]!;
        if (group.length > 1) {
          return (
            <li
              key={`g${key}`}
              className="flex items-center gap-2 rounded border border-danger bg-surface px-2 py-0.5 text-xs text-danger"
            >
              <span className="flex-1 truncate">
                {group.length} messages were dropped when {first.discardedBy ?? 'someone'} stopped
                the agent
              </span>
              <button
                type="button"
                className={BTN_DANGER}
                onClick={() => {
                  group.forEach((p) => onResend(p.text));
                  dismiss(seqs);
                }}
              >
                Resend all
              </button>
              <button type="button" className={BTN_DANGER} onClick={() => dismiss(seqs)}>
                Dismiss all
              </button>
            </li>
          );
        }
        return (
          <li
            key={first.seq}
            className="flex items-center gap-2 rounded border border-danger bg-surface px-2 py-0.5 text-xs text-danger"
          >
            <span className="font-semibold">{first.displayName}</span>
            <span className="flex-1 truncate" title={first.text}>
              {first.text}
            </span>
            <button
              type="button"
              aria-label={`Resend message from ${first.displayName}`}
              className={BTN_DANGER}
              onClick={() => {
                onResend(first.text);
                dismiss([first.seq]);
              }}
            >
              Resend
            </button>
            {onEdit !== undefined && (
              <button
                type="button"
                aria-label={`Edit message from ${first.displayName}`}
                className={BTN_DANGER}
                onClick={() => onEdit(first.text)}
              >
                Edit
              </button>
            )}
            <button
              type="button"
              aria-label={`Dismiss message from ${first.displayName}`}
              className={BTN_DANGER}
              onClick={() => dismiss([first.seq])}
            >
              Dismiss
            </button>
          </li>
        );
      })}
      {queued.map((prompt) => {
        // A resend is attributed to whoever sends it, so only the author may
        // jump their own prompt; never offer it on someone else's text.
        const own = selfId !== undefined && prompt.participantId === selfId;
        return (
          <li
            key={prompt.seq}
            className="flex items-center gap-2 rounded border border-warn bg-surface px-2 py-0.5 text-xs text-warn"
          >
            <span className="font-semibold">{prompt.displayName}</span>
            {prompt.wasDriver === true && <span className="text-[10px] uppercase">driver</span>}
            <span className="flex-1 truncate" title={prompt.text}>
              {prompt.text}
            </span>
            <span className="text-[10px]">
              Queued — goes to the agent when it finishes this turn
            </span>
            {own && onSendNow !== undefined && (
              <button
                type="button"
                aria-label={`Stop & send now: ${prompt.text}`}
                className={BTN_WARN}
                onClick={() => onSendNow([prompt.text])}
              >
                Stop &amp; send now
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
