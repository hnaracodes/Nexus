import { useId, useState } from 'react';
import { AlertTriangle, ShieldAlert, XCircle } from 'lucide-react';
import { summarizeInput } from '../approvals.js';
import type { PendingApproval } from '../approvals.js';
import { CountdownRing } from './CountdownRing.js';
import { classifyTool, summarizeToolInput } from './ToolSummary.js';

/** Mirrors src/server/permissions.ts DECISION_TIMEOUT_MS — display only. */
const DECISION_TIMEOUT_MS = 120_000;

/**
 * The governance centrepiece (BUILD_SPEC.md §9). Semantics that must never
 * change here, however the card is styled: ANY participant can decide, not
 * just the driver (no driverId/selfId prop exists on this component at all —
 * that is the enforcement, not a visual affordance); the first response wins;
 * a request nobody answers within 120s is denied (the expired placeholder
 * below). Approve and Deny are equally weighted, equally easy targets.
 */
export function ApprovalPrompt({
  approval,
  now,
  onDecide,
}: {
  approval: PendingApproval;
  now: number;
  onDecide: (requestId: string, decision: 'allow' | 'deny', reason?: string) => void;
}): JSX.Element {
  const [reason, setReason] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const rawInputId = useId();
  const secondsLeft = Math.max(0, Math.round((approval.expiresAt - now) / 1000));
  const totalSeconds = Math.max(1, Math.round(DECISION_TIMEOUT_MS / 1000));

  if (secondsLeft === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface p-3 text-sm text-fg-muted">
        <XCircle size={16} className="shrink-0 text-danger" aria-hidden="true" />
        <span>{approval.toolName} was denied — nobody responded in time.</span>
      </div>
    );
  }

  const risk = classifyTool(approval.toolName);
  const summary = summarizeToolInput(approval.toolName, approval.input);
  const isDestructive = risk === 'destructive';
  const RiskIcon = isDestructive ? AlertTriangle : ShieldAlert;

  return (
    <div
      role="group"
      aria-label={`Approval request for ${approval.toolName}`}
      aria-live="assertive"
      className={`flex flex-col gap-3 rounded-lg border-2 bg-surface p-4 ${
        isDestructive ? 'border-danger' : 'border-warn'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <RiskIcon
            size={20}
            className={`mt-0.5 shrink-0 ${isDestructive ? 'text-danger' : 'text-warn'}`}
            aria-hidden="true"
          />
          <h3 className="text-base font-semibold leading-snug text-fg">
            <span className="font-mono">{approval.toolName}</span>
            {' — '}
            <span className="font-normal text-fg-muted">{summary}</span>
          </h3>
        </div>
        <div className="flex flex-col items-center gap-1">
          <CountdownRing secondsLeft={secondsLeft} totalSeconds={totalSeconds} />
          <span className="text-xs text-fg-muted">{secondsLeft}s to decide</span>
        </div>
      </div>

      <p className="text-xs text-fg-muted">
        Anyone in the room can decide. The first response wins.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onDecide(approval.requestId, 'allow', undefined)}
          className="min-h-11 min-w-11 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-bg transition-colors duration-150 hover:brightness-110 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() =>
            onDecide(approval.requestId, 'deny', reason.trim() === '' ? undefined : reason.trim())
          }
          className="min-h-11 min-w-11 rounded-md border-2 border-danger px-4 py-2 text-sm font-semibold text-danger transition-colors duration-150 hover:bg-danger hover:text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          Deny
        </button>
        <label className="min-w-[10rem] flex-1">
          <span className="sr-only">Reason (optional)</span>
          <input
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason (optional)"
            className="min-h-11 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          />
        </label>
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowRaw((open) => !open)}
          aria-expanded={showRaw}
          aria-controls={rawInputId}
          className="min-h-11 rounded-md px-1 text-xs font-medium text-fg-muted underline decoration-dotted underline-offset-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {showRaw ? 'Hide raw input' : 'Show raw input'}
        </button>
        {showRaw && (
          <pre
            id={rawInputId}
            className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-bg p-2 font-mono text-xs text-fg"
          >
            {summarizeInput(approval.input)}
          </pre>
        )}
      </div>
    </div>
  );
}
