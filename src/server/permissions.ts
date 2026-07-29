import { randomUUID } from 'node:crypto';
import type { UnsequencedEvent } from '../protocol/events.js';
import type { Room } from './rooms.js';

export const DECISION_TIMEOUT_MS = 120_000;

/**
 * Read-only tools decide themselves. Without this the room becomes a clicking
 * simulator and people turn the feature off — and the feature is the product.
 */
export const AUTO_APPROVE: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'TodoWrite',
]);

export interface Decision {
  decision: 'allow' | 'deny';
  participantId: string | null;
  displayName: string | null;
  /** 'first_response' | 'auto_approved' | 'timeout' */
  via: string;
  reason: string | null;
}

/**
 * Returns the settled decision, or null to keep waiting. Swapping this for a
 * majority or owner-only rule is the only change those policies require.
 */
export type DecisionPolicy = (existing: Decision[], incoming: Decision) => Decision | null;

export const firstResponseWins: DecisionPolicy = (_existing, incoming) => incoming;

export interface PermissionGate {
  /**
   * Suspends until the room decides, auto-approves, the timeout denies, or
   * `signal` aborts. The SDK passes its own `AbortSignal` — if the agent is
   * interrupted or torn down while a request is outstanding, an unaborted
   * gate leaks a pending promise and a live timer per abandoned request.
   */
  request(toolName: string, input: unknown, signal?: AbortSignal): Promise<Decision>;
  /** Returns false if the id is unknown or already settled. */
  resolve(requestId: string, decision: Decision): boolean;
  pendingIds(): string[];
}

interface Pending {
  settle(decision: Decision): void;
  votes: Decision[];
  toolName: string;
}

export function createPermissionGate(
  room: Room,
  emit: (event: UnsequencedEvent) => void,
  options: {
    timeoutMs?: number;
    policy?: DecisionPolicy;
    autoApprove?: ReadonlySet<string>;
  } = {},
): PermissionGate {
  const timeoutMs = options.timeoutMs ?? DECISION_TIMEOUT_MS;
  const policy = options.policy ?? firstResponseWins;
  const autoApprove = options.autoApprove ?? AUTO_APPROVE;
  const pending = new Map<string, Pending>();

  function publish(requestId: string, toolName: string, decision: Decision): void {
    emit({
      type: 'permission_decided',
      requestId,
      toolName,
      decision: decision.decision,
      participantId: decision.participantId,
      displayName: decision.displayName,
      via: decision.via,
      reason: decision.reason,
    });
  }

  return {
    request(toolName: string, input: unknown, signal?: AbortSignal): Promise<Decision> {
      const requestId = `req_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

      if (autoApprove.has(toolName)) {
        const decision: Decision = {
          decision: 'allow',
          participantId: null,
          displayName: null,
          via: 'auto_approved',
          reason: null,
        };
        publish(requestId, toolName, decision);
        return Promise.resolve(decision);
      }

      return new Promise<Decision>((resolveOuter) => {
        const expiresAt = Date.now() + timeoutMs;

        const timer = setTimeout(() => {
          pending.delete(requestId);
          const decision: Decision = {
            decision: 'deny',
            participantId: null,
            displayName: null,
            via: 'timeout',
            reason: `Nobody in the room responded within ${Math.round(timeoutMs / 1000)}s, so this was denied.`,
          };
          publish(requestId, toolName, decision);
          resolveOuter(decision);
        }, timeoutMs);

        const entry: Pending = {
          toolName,
          votes: [],
          settle(decision: Decision): void {
            clearTimeout(timer);
            pending.delete(requestId);
            publish(requestId, toolName, decision);
            resolveOuter(decision);
          },
        };
        pending.set(requestId, entry);

        // The SDK aborts when the agent is interrupted or shut down. Settle as
        // a deny so the promise never dangles and the timer is cleared.
        signal?.addEventListener(
          'abort',
          () => {
            if (!pending.has(requestId)) return; // already decided
            entry.settle({
              decision: 'deny',
              participantId: null,
              displayName: null,
              via: 'aborted',
              reason: 'The agent was interrupted before the room decided.',
            });
          },
          { once: true },
        );

        // Every participant sees this, not just the driver. Governance is
        // deliberately decoupled from the driver token.
        emit({ type: 'permission_requested', requestId, toolName, input, expiresAt });
      });
    },

    resolve(requestId: string, decision: Decision): boolean {
      const entry = pending.get(requestId);
      if (entry === undefined) return false;
      entry.votes.push(decision);
      const settled = policy(entry.votes.slice(0, -1), decision);
      if (settled === null) return true;
      entry.settle(settled);
      return true;
    },

    pendingIds(): string[] {
      return [...pending.keys()];
    },
  };
}
