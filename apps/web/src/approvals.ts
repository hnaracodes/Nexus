import type { SynCodeEvent } from '@syncode/protocol/events';

export interface PendingApproval {
  requestId: string;
  toolName: string;
  input: unknown;
  expiresAt: number;
}

export interface SettledApproval {
  requestId: string;
  toolName: string;
  decision: 'allow' | 'deny';
  displayName: string | null;
  via: string;
  reason: string | null;
}

/** Derived from the log, not stored — the log stays authoritative (I3). */
export function deriveApprovals(events: SynCodeEvent[]): {
  pending: PendingApproval[];
  settled: SettledApproval[];
} {
  const pending = new Map<string, PendingApproval>();
  const settled: SettledApproval[] = [];

  for (const event of events) {
    if (event.type === 'permission_requested') {
      pending.set(event.requestId, {
        requestId: event.requestId,
        toolName: event.toolName,
        input: event.input,
        expiresAt: event.expiresAt,
      });
    }
    if (event.type === 'permission_decided') {
      pending.delete(event.requestId);
      settled.push({
        requestId: event.requestId,
        toolName: event.toolName,
        decision: event.decision,
        displayName: event.displayName,
        via: event.via,
        reason: event.reason,
      });
    }
  }

  return { pending: [...pending.values()], settled };
}

/** Untrusted, possibly huge. Always rendered as preformatted text. */
export function summarizeInput(input: unknown, maxChars = 2000): string {
  const text = typeof input === 'string' ? input : (JSON.stringify(input, null, 2) ?? String(input));
  return text.slice(0, maxChars);
}
