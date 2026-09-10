import { randomUUID } from 'node:crypto';
import type { UnsequencedEvent } from '@nexus/protocol/events';
import type { Room } from './rooms.js';
import { isAutoApproved } from './runtime/autoApprove.js';

export const DECISION_TIMEOUT_MS = 120_000;

/**
 * Re-exported rather than redefined. `runtime/autoApprove.ts` owns this list
 * now (phase 10) because a bare Set of Claude names stopped being the whole
 * story the moment a tool could be spelled `mcp__nexus__read_file` or
 * `read_file` — see that file for why the gate below defaults to a predicate
 * instead. This re-export exists only so existing callers and the pinned test
 * that import `AUTO_APPROVE` from here keep working unchanged.
 */
export { AUTO_APPROVE } from './runtime/autoApprove.js';

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

/**
 * The seam phase 12's approval queue plugs into (D3 in
 * `docs/plans/phase-12-fleet.md`): who decides WHEN a request's timeout clock
 * may start, and who is told when the request is fully done so a queued slot
 * can free up.
 *
 * The default below — `admit` resolves immediately, `release` does nothing —
 * reproduces today's exact behaviour: at one agent, "created" and "visible"
 * are the same instant, because there is only ever one card. Only a room
 * with a real queue (`approvalQueue.ts`, shared by every agent's gate in the
 * room) supplies a delaying `admit`, and only then does "queued" become a
 * state a request can be in at all.
 */
export interface RequestVisibility {
  /**
   * Calls `surface` once the room may see this request and its clock may start.
   *
   * A CALLBACK, not a promise, and the difference is load-bearing rather than
   * stylistic. The first version of this seam returned `Promise<void>` and its
   * own comment claimed the default was "byte-identical to before this seam
   * existed". It was not: `Promise.resolve()` still defers by a microtask, so
   * `permission_requested` moved from inside `request()` to after it returned.
   * Nothing type-checked differently and every unit test still passed — and the
   * server suite went FLAKY, a different handful of socket tests failing on each
   * run, because callers that had been able to rely on the event existing before
   * the next synchronous statement no longer could.
   *
   * With a callback, an immediately-visible request surfaces SYNCHRONOUSLY —
   * which is every request in a single-agent room, and every request in a fleet
   * with a free slot — while a queue is still free to call `surface` later.
   */
  admit(requestId: string, toolName: string, surface: () => void): void;
  /**
   * Called exactly once a request is fully done — decided, timed out, or
   * aborted — including while it was still queued and never admitted at all.
   * A queue must tolerate being told to release a requestId it never saw.
   */
  release(requestId: string): void;
}

const IMMEDIATE_VISIBILITY: RequestVisibility = {
  // Synchronous on purpose. See `admit`'s doc above.
  admit: (_requestId, _toolName, surface) => surface(),
  release: () => {},
};

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
    /**
     * The DEFAULT is `isAutoApproved`, a predicate — not `AUTO_APPROVE`, a
     * fixed Set — because the gate must keep approving a read-only tool no
     * matter how a given provider or MCP wrapping spells its name (see
     * `runtime/autoApprove.ts`). A `ReadonlySet` is still accepted: several
     * existing tests inject one to pin an exact, closed vocabulary, and a
     * Set's own `.has` is just a predicate that happens to be pre-computed.
     */
    autoApprove?: ReadonlySet<string> | ((toolName: string) => boolean);
    /** Defaults to `IMMEDIATE_VISIBILITY` — see `RequestVisibility` above. */
    visibility?: RequestVisibility;
  } = {},
): PermissionGate {
  const timeoutMs = options.timeoutMs ?? DECISION_TIMEOUT_MS;
  const policy = options.policy ?? firstResponseWins;
  const autoApprove = options.autoApprove ?? isAutoApproved;
  const visibility = options.visibility ?? IMMEDIATE_VISIBILITY;
  const isApproved = (toolName: string): boolean =>
    typeof autoApprove === 'function' ? autoApprove(toolName) : autoApprove.has(toolName);
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

      if (isApproved(toolName)) {
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
        // Set only once `visibility.admit` resolves — see `settle` below for
        // why a decision that was never surfaced logs nothing at all.
        let surfaced = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const entry: Pending = {
          toolName,
          votes: [],
          settle(decision: Decision): void {
            if (timer !== undefined) clearTimeout(timer);
            pending.delete(requestId);
            visibility.release(requestId);
            // A request nobody ever saw has nothing for the log to say
            // happened — no clock ran, no card existed. Logging it anyway
            // would read as "the room decided" on a question it never saw,
            // exactly the confusion D3 exists to prevent. A surfaced request
            // always gets both a `permission_requested` and a matching
            // `permission_decided`; an unsurfaced one gets neither.
            if (surfaced) publish(requestId, toolName, decision);
            resolveOuter(decision);
          },
        };
        // Set BEFORE admission, not after: `pendingIds()` must still count a
        // queued-but-invisible request, or a fleet's per-agent pending count
        // would silently undercount exactly the requests D3 exists to protect.
        pending.set(requestId, entry);

        // The SDK aborts when the agent is interrupted or shut down. Settle as
        // a deny so the promise never dangles and the timer — if one was ever
        // armed — is cleared. One listener covers both the queued and the
        // surfaced case: `entry.settle` reads `surfaced` at the moment this
        // fires, not at registration time, so an abort while still queued
        // logs nothing and an abort after surfacing logs the pair as usual.
        signal?.addEventListener(
          'abort',
          () => {
            if (!pending.has(requestId)) return; // already settled
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

        // THE D3 SEAM. Everything above this point is invisible to the room —
        // no timer armed, no event emitted, nothing an observer could call
        // "the room's clock" starting. `visibility.admit` resolves the
        // instant this request may be shown; `IMMEDIATE_VISIBILITY` resolves
        // on the same microtask turn every pre-fleet gate did, so a
        // single-agent room is byte-identical to before this seam existed. A
        // real queue (`approvalQueue.ts`) can instead hold this request
        // behind others and resolve only once a visible slot is free.
        visibility.admit(requestId, toolName, () => {
          if (!pending.has(requestId)) return; // settled (aborted) while queued
          surfaced = true;
          const expiresAt = Date.now() + timeoutMs;

          timer = setTimeout(() => {
            // Routed through `entry.settle` rather than repeating its effects
            // here — see `settle` above for why that indirection is load-
            // bearing. `clearTimeout` on the timer currently firing is a no-op.
            entry.settle({
              decision: 'deny',
              participantId: null,
              displayName: null,
              via: 'timeout',
              reason: `Nobody in the room responded within ${Math.round(timeoutMs / 1000)}s, so this was denied.`,
            });
          }, timeoutMs);

          // Every participant sees this, not just the driver. Governance is
          // deliberately decoupled from the driver token.
          emit({ type: 'permission_requested', requestId, toolName, input, expiresAt });
        });
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
