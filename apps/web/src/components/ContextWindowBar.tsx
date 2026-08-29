import { Gauge } from 'lucide-react';
import type { NexusEvent } from '@nexus/protocol/events';

/** Ratios at and above these thresholds get a warn/danger treatment. */
const WARN_THRESHOLD = 0.7;
const DANGER_THRESHOLD = 0.9;

function barColor(ratio: number): string {
  if (ratio >= DANGER_THRESHOLD) return 'bg-danger';
  if (ratio >= WARN_THRESHOLD) return 'bg-warn';
  return 'bg-accent';
}

/**
 * How much of the model's context window the room has used, derived from
 * the LAST `context_usage` event in the log (I3 — never a local mirror).
 *
 * **Never fabricate a number.** A room that has not completed a turn yet has
 * logged no `context_usage` event at all, and that is the common path, not
 * an edge case — every room starts there. Rendering 0% in that state would
 * be a lie a participant could act on (starting a long task believing there
 * is headroom nobody has actually measured yet), so this renders an explicit
 * "usage unavailable" instead.
 */
export function ContextWindowBar({ events }: { events: NexusEvent[] }): JSX.Element {
  const usageEvents = events.filter(
    (event): event is Extract<NexusEvent, { type: 'context_usage' }> => event.type === 'context_usage',
  );
  const latest = usageEvents[usageEvents.length - 1];

  if (latest === undefined) {
    return (
      <div
        className="flex min-h-11 items-center gap-1.5 rounded border border-border px-2 text-xs text-fg-muted"
        title="No turn has completed yet, so context usage is not known"
      >
        <Gauge size={14} aria-hidden="true" />
        <span>Usage unavailable</span>
      </div>
    );
  }

  const usedTokens = latest.inputTokens + latest.cacheReadInputTokens + latest.cacheCreationInputTokens;
  // contextWindow is server-reported and should never be 0, but a defensive
  // guard beats rendering Infinity/NaN if a future model ever reports one.
  const ratio = latest.contextWindow > 0 ? Math.min(1, usedTokens / latest.contextWindow) : 0;
  const percent = Math.round(ratio * 100);

  return (
    <div
      className="flex min-h-11 items-center gap-2 rounded border border-border px-2 text-xs text-fg-muted"
      title={`${usedTokens.toLocaleString()} / ${latest.contextWindow.toLocaleString()} tokens (${percent}%)`}
    >
      <Gauge size={14} aria-hidden="true" />
      <div
        role="progressbar"
        aria-label="Context window usage"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-16 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-150 ease-out ${barColor(ratio)}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-fg">{`${percent}%`}</span>
      {latest.compactedFromTokens !== null && (
        <span
          className="rounded-full border border-border px-1.5 py-0.5 text-fg-muted"
          title={`Compacted from ${latest.compactedFromTokens.toLocaleString()} tokens`}
        >
          Compacted
        </span>
      )}
    </div>
  );
}
