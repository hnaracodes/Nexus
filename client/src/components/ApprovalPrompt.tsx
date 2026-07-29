import { useState } from 'react';
import { summarizeInput } from '../approvals.js';
import type { PendingApproval } from '../approvals.js';

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
  const secondsLeft = Math.max(0, Math.round((approval.expiresAt - now) / 1000));

  if (secondsLeft === 0) {
    return (
      <div className="rounded border border-slate-300 bg-slate-50 p-3 text-xs text-slate-600">
        {approval.toolName} was denied — nobody responded in time.
      </div>
    );
  }

  return (
    <div className="rounded border-2 border-amber-400 bg-amber-50 p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="font-semibold text-amber-900">{approval.toolName}</span>
        <span className="text-xs text-amber-800">{secondsLeft}s to decide</span>
      </div>

      <pre className="mb-3 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-xs">
        {summarizeInput(approval.input)}
      </pre>

      {/* Any participant can decide — never gate on driverId. Governance is
          deliberately decoupled from the driver token. */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onDecide(approval.requestId, 'allow', undefined)}
          className="rounded bg-emerald-600 px-3 py-1 text-sm text-white"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() =>
            onDecide(approval.requestId, 'deny', reason.trim() === '' ? undefined : reason.trim())
          }
          className="rounded bg-rose-600 px-3 py-1 text-sm text-white"
        >
          Deny
        </button>
        <input
          type="text"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="reason (optional)"
          className="flex-1 rounded border border-amber-300 px-2 py-1 text-sm"
        />
      </div>

      <p className="mt-2 text-xs text-amber-800">Anyone in the room can decide this.</p>
    </div>
  );
}
