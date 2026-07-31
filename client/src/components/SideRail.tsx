import { CheckCircle2, XCircle } from 'lucide-react';
import type { NexusEvent } from '../../../src/protocol/events.js';
import type { PresenceEntry } from '../../../src/protocol/wire.js';
import { deriveApprovals } from '../approvals.js';
import { PendingPrompts } from './PendingPrompts.js';
import { Roster } from './Roster.js';

export interface SideRailProps {
  participants: PresenceEntry[];
  driverId: string | null;
  selfId: string | null;
  events: NexusEvent[];
  onRequestControl: () => void;
  onReleaseControl: () => void;
  onGrantControl: (participantId: string) => void;
  onResendPrompt: (text: string) => void;
}

/**
 * The right-hand rail: full participant roster, the queued-prompt list, and
 * the approval audit trail (pending count plus settled history — settled
 * approvals are already derived by `deriveApprovals` and were never rendered
 * anywhere before this). Below `lg` this collapses to a bottom sheet with a
 * badge count; that responsive behaviour is wired by the integration task
 * (Task 8 Step 2/3), not here — this component only needs to work correctly
 * when it is visible.
 */
export function SideRail({
  participants,
  driverId,
  selfId,
  events,
  onRequestControl,
  onReleaseControl,
  onGrantControl,
  onResendPrompt,
}: SideRailProps): JSX.Element {
  const { pending, settled } = deriveApprovals(events);

  return (
    <aside
      aria-label="Room sidebar"
      className="flex h-full min-h-0 w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-surface p-3"
    >
      <section aria-labelledby="side-rail-participants">
        <h2 id="side-rail-participants" className="mb-2 text-xs font-semibold uppercase text-fg-muted">
          Participants
        </h2>
        <Roster
          participants={participants}
          driverId={driverId}
          selfId={selfId}
          onRequestControl={onRequestControl}
          onReleaseControl={onReleaseControl}
          onGrantControl={onGrantControl}
        />
      </section>

      <section aria-labelledby="side-rail-queue">
        <h2 id="side-rail-queue" className="mb-2 text-xs font-semibold uppercase text-fg-muted">
          Queued prompts
        </h2>
        <PendingPrompts events={events} onResend={onResendPrompt} />
      </section>

      <section aria-labelledby="side-rail-approvals">
        <h2 id="side-rail-approvals" className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-fg-muted">
          Approvals
          {pending.length > 0 && (
            <span className="rounded-full bg-warn px-1.5 py-0.5 text-[10px] font-semibold text-bg">
              {pending.length}
            </span>
          )}
        </h2>
        {settled.length === 0 ? (
          <p className="text-xs text-fg-muted">No decisions yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {settled.map((approval) => (
              <li
                key={approval.requestId}
                className="flex items-start gap-2 rounded border border-border bg-bg px-2 py-1 text-xs"
              >
                {approval.decision === 'allow' ? (
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                ) : (
                  <XCircle size={14} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-fg">{approval.toolName}</span>{' '}
                  <span className="text-fg-muted">
                    {approval.decision === 'allow' ? 'approved' : 'denied'}
                    {approval.displayName !== null ? ` by ${approval.displayName}` : ' automatically'}
                  </span>
                  {approval.reason !== null && (
                    <span className="block text-fg-muted">"{approval.reason}"</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
