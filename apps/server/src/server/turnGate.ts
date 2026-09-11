/**
 * Holds prompts that arrive while the agent is mid-turn and releases them as
 * one attributed batch at the next turn boundary.
 *
 * Why this exists: the SDK's streamInput (sdk.mjs:8449) is a bare `for await`
 * that writes every yielded message straight to the CLI subprocess's stdin the
 * instant the iterable produces it. It does NOT wait for the current turn to
 * finish, and what the CLI does with a mid-turn message is undocumented — its
 * bundle is minified and unreadable. So we do the queueing ourselves, gated on
 * `agent_idle`, which we already emit from the SDK's `result` message.
 *
 * Pure by design: no SDK import, no timers, no I/O, so it unit-tests directly
 * the way driver.ts does.
 */

export interface PendingPrompt {
  /** The seq of the already-committed `user_prompt` event. */
  seq: number;
  displayName: string;
  text: string;
  wasDriver: boolean;
}

export interface Batch {
  /** Exactly what to hand the agent. */
  text: string;
  promptSeqs: number[];
}

/**
 * One OTHER agent's identity and coarse status, for the roster preamble a
 * turn's text may carry (phase 17d, `Roster` below). `provider` and `status`
 * are plain strings rather than `@syncode/protocol`'s `AgentProvider`/
 * `AgentStatus` unions — this module's own doc comment above promises "no SDK
 * import, no timers, no I/O", and the caller (`fleet.ts`'s `buildRosterView`)
 * already holds the real union types and narrows them to strings when it
 * builds one of these, so nothing is lost by keeping this module's only
 * dependency on itself.
 */
export interface RosterPeer {
  displayName: string;
  /**
   * The peer's agent id, and the reason this interface carries one.
   *
   * A display name is whatever a driver typed into `spawn_agent`; nothing makes
   * it unique, and `agentId` is the identity everywhere else in the system.
   * A live room proved the difference: it held two agents both named "Beta"
   * plus a second "Alpha" beside the Alpha being prompted, and the real agent,
   * asked to list its siblings, flagged "Beta (appears twice)" and silently
   * dropped the namesake Alpha — reading that line as itself. A roster nobody
   * can act on is decoration, and the moment an agent may address a sibling
   * this field becomes the address.
   */
  agentId: string;
  provider: string;
  status: string;
}

/**
 * What a turn's text may say about the fleet it runs inside (phase 17d).
 * Built fresh by the caller — see `AgentDeps.roster` in `agent.ts` — and
 * passed straight into `submit`/`onIdle` below. `render` never reaches out
 * for this itself; it stays a pure function of whatever it is handed, exactly
 * as before this phase, so a room that never supplies one renders identically
 * to a room that has never heard of phase 17d.
 */
export interface Roster {
  /** This agent's own display name, so the turn can say which one it is — an
   *  agent that knows others exist but not which one it is will guess. */
  selfDisplayName: string;
  /** And its own id, for the same reason the peers carry theirs: a namesake in
   *  the list is otherwise indistinguishable from itself. Required, not
   *  optional — an identity that can be omitted is one that will be. */
  selfAgentId: string;
  /** Every OTHER live (non-stopped) agent in the room. An empty list means
   *  "alone" and is treated exactly like passing no roster at all: no
   *  preamble, because a lone agent has no siblings to be told about. */
  others: RosterPeer[];
}

export interface TurnGate {
  /** Returns a batch to deliver now, or null if it was buffered for later.
   *  `roster`, when supplied and non-empty, prefixes the rendered text —
   *  omitted (or passed as null/undefined), a batch renders exactly as it did
   *  before phase 17d. */
  submit(prompt: PendingPrompt, roster?: Roster | null): Batch | null;
  /** Call when `agent_idle` is observed. Returns the next batch, or null. */
  onIdle(roster?: Roster | null): Batch | null;
  /** Drop everything buffered; returns the seqs dropped. For interrupt. */
  discard(): number[];
}

export function createTurnGate(): TurnGate {
  // Starts idle: at room start the agent has never emitted `agent_idle`, so a
  // first prompt must go straight through rather than wait for a boundary that
  // will never arrive.
  let busy = false;

  // Insertion order IS seq order by construction — commit() and submit() run in
  // the same synchronous tick of the WS message handler. Do not add a sort.
  let buffer: PendingPrompt[] = [];

  function flush(roster: Roster | null): Batch | null {
    if (buffer.length === 0) return null;
    const batch = buffer;
    buffer = [];
    busy = true;
    return { text: render(batch, roster), promptSeqs: batch.map((p) => p.seq) };
  }

  return {
    submit(prompt: PendingPrompt, roster: Roster | null = null): Batch | null {
      buffer.push(prompt);
      return busy ? null : flush(roster);
    },
    onIdle(roster: Roster | null = null): Batch | null {
      busy = false;
      return flush(roster);
    },
    discard(): number[] {
      const dropped = buffer.map((p) => p.seq);
      buffer = [];
      // An interrupt ends the turn. Leaving `busy` true would strand the next
      // prompt until an `agent_idle` that may never come.
      busy = false;
      return dropped;
    },
  };
}

/**
 * A lone prompt with no roster renders exactly as it did before Phase 4 — the
 * existing suite and the 24/24 live acceptance run assert on that string.
 * Only a genuine multi-person batch gets the envelope, and only there does
 * the driver marker mean anything: precedence is a rule for resolving a
 * conflict, and one prompt cannot conflict with itself. The roster preamble
 * (phase 17d) is an independent concern, prefixed ahead of whichever of these
 * two shapes applies, and absent entirely when there is no one else — see
 * `renderRosterPreamble` below.
 */
function render(batch: PendingPrompt[], roster: Roster | null): string {
  const preamble = renderRosterPreamble(roster);
  const body = renderBody(batch);
  return preamble === '' ? body : `${preamble}\n\n${body}`;
}

function renderBody(batch: PendingPrompt[]): string {
  const first = batch[0];
  if (batch.length === 1 && first !== undefined) {
    return `[${first.displayName}]: ${first.text}`;
  }
  const lines = batch.map((p) => `[${p.displayName}${p.wasDriver ? ' — driver' : ''}] ${p.text}`);
  return [
    'The following prompts arrived together from different people in this room.',
    ...lines,
  ].join('\n');
}

/**
 * Empty string — not rendered at all — whenever there is no one else:
 * `roster === null` and an empty `others` list are deliberately treated the
 * same, so a single-agent room's turn text is byte-for-byte what it was
 * before this phase (the phase-17d test bar). Only when the fleet actually
 * holds a sibling does this say anything, and when it does it always both
 * names the sibling AND names the recipient — an agent that knows others
 * exist but not which one it is will guess.
 */
function renderRosterPreamble(roster: Roster | null): string {
  if (roster === null || roster.others.length === 0) return '';
  const lines = roster.others.map(
    (peer) => `  - ${peer.displayName} [${peer.agentId}] (${peer.provider}, ${peer.status})`,
  );
  return [
    'Other agents are working in this room right now:',
    ...lines,
    `You are ${roster.selfDisplayName} [${roster.selfAgentId}]. You share the working`,
    'directory with them. Display names are not unique — the bracketed id is the',
    'only thing that identifies an agent, including which one is you.',
  ].join('\n');
}
