import { beforeEach, describe, expect, it } from 'vitest';
import { createTurnGate } from '../../src/server/turnGate.js';
import type { TurnGate } from '../../src/server/turnGate.js';

let gate: TurnGate;
beforeEach(() => {
  gate = createTurnGate();
});

describe('turn gate', () => {
  it('flushes the first prompt immediately — an idle room must not add latency', () => {
    const batch = gate.submit({ seq: 1, displayName: 'Ada', text: 'go', wasDriver: true });
    expect(batch).not.toBeNull();
    expect(batch?.promptSeqs).toEqual([1]);
  });

  it('renders a single-prompt batch byte-identically to the pre-Phase-4 format', () => {
    const batch = gate.submit({ seq: 1, displayName: 'Ada', text: 'go', wasDriver: true });
    expect(batch?.text).toBe('[Ada]: go');
  });

  it('renders a lone non-driver prompt in the same legacy format', () => {
    // The envelope marks precedence, and precedence is meaningless with one
    // prompt. A solo speaker must read identically whether or not they drive.
    const batch = gate.submit({ seq: 1, displayName: 'Bob', text: 'go', wasDriver: false });
    expect(batch?.text).toBe('[Bob]: go');
  });

  it('holds prompts that arrive mid-turn and releases them as ONE batch', () => {
    gate.submit({ seq: 1, displayName: 'Ada', text: 'first', wasDriver: true });
    expect(gate.submit({ seq: 2, displayName: 'Bob', text: 'second', wasDriver: false })).toBeNull();
    expect(gate.submit({ seq: 3, displayName: 'Cara', text: 'third', wasDriver: false })).toBeNull();

    const batch = gate.onIdle();
    expect(batch?.promptSeqs).toEqual([2, 3]);
  });

  it('handles two prompts submitted in the same tick without throwing', () => {
    gate.submit({ seq: 1, displayName: 'Ada', text: 'occupy the turn', wasDriver: true });
    // Back-to-back in one synchronous tick — the "both typed at once" case.
    expect(() => {
      gate.submit({ seq: 2, displayName: 'Bob', text: 'check lint', wasDriver: false });
      gate.submit({ seq: 3, displayName: 'Cara', text: 'and typecheck', wasDriver: false });
    }).not.toThrow();

    const batch = gate.onIdle();
    expect(batch?.promptSeqs).toEqual([2, 3]);
    expect(batch?.text).toContain('[Bob] check lint');
    expect(batch?.text).toContain('[Cara] and typecheck');
  });

  it('marks the driver in a multi-prompt batch', () => {
    gate.submit({ seq: 1, displayName: 'Ada', text: 'occupy', wasDriver: true });
    gate.submit({ seq: 2, displayName: 'Ada', text: 'do X', wasDriver: true });
    gate.submit({ seq: 3, displayName: 'Bob', text: 'do Y', wasDriver: false });

    const batch = gate.onIdle();
    expect(batch?.text).toContain('[Ada — driver] do X');
    expect(batch?.text).toContain('[Bob] do Y');
  });

  it('preserves submission order in the rendered batch, not just in promptSeqs', () => {
    gate.submit({ seq: 1, displayName: 'Ada', text: 'occupy', wasDriver: true });
    gate.submit({ seq: 2, displayName: 'Bob', text: 'first', wasDriver: false });
    gate.submit({ seq: 3, displayName: 'Cara', text: 'second', wasDriver: false });

    const text = gate.onIdle()?.text ?? '';
    expect(text.indexOf('[Bob] first')).toBeLessThan(text.indexOf('[Cara] second'));
  });

  it('flushes nothing on idle with an empty buffer — never push an empty turn', () => {
    gate.submit({ seq: 1, displayName: 'Ada', text: 'go', wasDriver: true });
    expect(gate.onIdle()).toBeNull();
  });

  it('delivers a prompt typed after a quiet turn ended', () => {
    // The ordinary case, and the one the assertion above misses: someone waits
    // for the agent to finish, then types. Found by mutation testing — deleting
    // `busy = false` from onIdle() left every earlier test green, because when
    // the buffer is non-empty flush() sets busy itself. It only bites when the
    // turn ends with nothing queued, and then it strands the room: the next
    // prompt is buffered awaiting an agent_idle that cannot come, because
    // nothing was sent.
    gate.submit({ seq: 1, displayName: 'Ada', text: 'go', wasDriver: true });
    expect(gate.onIdle()).toBeNull();

    const batch = gate.submit({ seq: 2, displayName: 'Bob', text: 'now me', wasDriver: false });
    expect(batch?.promptSeqs).toEqual([2]);
  });

  it('discards buffered prompts and reports what it dropped', () => {
    gate.submit({ seq: 1, displayName: 'Ada', text: 'occupy', wasDriver: true });
    gate.submit({ seq: 2, displayName: 'Bob', text: 'queued', wasDriver: false });

    expect(gate.discard()).toEqual([2]);
    expect(gate.discard()).toEqual([]);
    // After a discard the gate is idle again: the interrupt ends the turn.
    expect(gate.onIdle()).toBeNull();
  });

  it('delivers the next prompt immediately after a discard', () => {
    // The regression this guards: if discard() left `busy` true, the prompt
    // someone types right after hitting Stop would sit in the buffer waiting
    // for an `agent_idle` that the interrupted turn already emitted.
    gate.submit({ seq: 1, displayName: 'Ada', text: 'occupy', wasDriver: true });
    gate.submit({ seq: 2, displayName: 'Bob', text: 'queued', wasDriver: false });
    gate.discard();

    const batch = gate.submit({ seq: 3, displayName: 'Bob', text: 'retry', wasDriver: false });
    expect(batch?.promptSeqs).toEqual([3]);
  });

  it('returns to buffering after a flush — one idle does not open the floodgates', () => {
    gate.submit({ seq: 1, displayName: 'Ada', text: 'one', wasDriver: true });
    gate.submit({ seq: 2, displayName: 'Bob', text: 'two', wasDriver: false });
    expect(gate.onIdle()?.promptSeqs).toEqual([2]);
    // That flush made the gate busy again; the next prompt must be held.
    expect(gate.submit({ seq: 3, displayName: 'Cara', text: 'three', wasDriver: false })).toBeNull();
  });
});

/**
 * Phase 17d — agents know their siblings exist. `render` (private) gains a
 * roster preamble, passed IN by the caller rather than fetched — this module
 * stays exactly as pure as its own doc comment claims. `submit`/`onIdle` both
 * take an optional `roster`, defaulting to none, so every caller (and every
 * test above) that never passes one keeps the pre-17d behaviour byte for
 * byte — that is the whole test bar for a single-agent room.
 */
describe('turn gate — sibling roster preamble (phase 17d)', () => {
  it('omits the roster entirely when none is supplied — the existing behaviour, untouched', () => {
    const batch = gate.submit({ seq: 1, displayName: 'Ada', text: 'go', wasDriver: true });
    expect(batch?.text).toBe('[Ada]: go');
  });

  it('omits the roster when one is supplied but names no one else', () => {
    const batch = gate.submit(
      { seq: 1, displayName: 'Ada', text: 'go', wasDriver: true },
      { selfDisplayName: 'Agent', selfAgentId: 'primary', others: [] },
    );
    expect(batch?.text).toBe('[Ada]: go');
  });

  it('prefixes the turn with a roster naming every other agent and this one', () => {
    const batch = gate.submit(
      { seq: 1, displayName: 'Ada', text: 'go', wasDriver: true },
      {
        selfDisplayName: 'Scout',
        selfAgentId: 'agent_scout00000000',
        others: [{ displayName: 'Alpha', agentId: 'agent_alpha00000000', provider: 'anthropic', status: 'idle' }],
      },
    );
    expect(batch?.text).toContain('Other agents are working in this room right now:');
    expect(batch?.text).toContain('- Alpha [agent_alpha00000000] (anthropic, idle)');
    expect(batch?.text).toContain('You are Scout [agent_scout00000000].');
    // The roster comes BEFORE the prompt body, not after.
    expect(batch?.text.endsWith('[Ada]: go')).toBe(true);
  });

  it('names the RECIPIENT correctly — same fleet, opposite self, seen from each side', () => {
    const alpha = { displayName: 'Alpha', agentId: 'agent_alpha00000000', provider: 'anthropic', status: 'idle' };
    const beta = { displayName: 'Beta', agentId: 'agent_beta000000000', provider: 'anthropic', status: 'working' };
    const alphaGate = createTurnGate();
    const betaGate = createTurnGate();

    const alphaBatch = alphaGate.submit(
      { seq: 1, displayName: 'Ada', text: 'go', wasDriver: true },
      { selfDisplayName: 'Alpha', selfAgentId: 'agent_alpha00000000', others: [beta] },
    );
    const betaBatch = betaGate.submit(
      { seq: 1, displayName: 'Ada', text: 'go', wasDriver: true },
      { selfDisplayName: 'Beta', selfAgentId: 'agent_beta000000000', others: [alpha] },
    );

    expect(alphaBatch?.text).toContain('You are Alpha [agent_alpha00000000].');
    expect(alphaBatch?.text).toContain('- Beta [agent_beta000000000] (anthropic, working)');
    expect(alphaBatch?.text).not.toContain('You are Beta [agent_beta000000000].');

    expect(betaBatch?.text).toContain('You are Beta [agent_beta000000000].');
    expect(betaBatch?.text).toContain('- Alpha [agent_alpha00000000] (anthropic, idle)');
    expect(betaBatch?.text).not.toContain('You are Alpha [agent_alpha00000000].');
  });

  it('carries a supplied roster through onIdle too, not just the first-prompt path', () => {
    gate.submit({ seq: 1, displayName: 'Ada', text: 'occupy', wasDriver: true });
    gate.submit({ seq: 2, displayName: 'Bob', text: 'queued', wasDriver: false });
    const batch = gate.onIdle({
      selfDisplayName: 'Agent',
      selfAgentId: 'primary',
      others: [{ displayName: 'Runner', agentId: 'agent_runner0000000', provider: 'google', status: 'idle' }],
    });
    expect(batch?.text).toContain('You are Agent [primary].');
    expect(batch?.text).toContain('- Runner [agent_runner0000000] (google, idle)');
  });

  it('still marks the driver correctly in a multi-prompt batch that also carries a roster', () => {
    gate.submit({ seq: 1, displayName: 'Ada', text: 'occupy', wasDriver: true });
    gate.submit({ seq: 2, displayName: 'Ada', text: 'do X', wasDriver: true });
    gate.submit({ seq: 3, displayName: 'Bob', text: 'do Y', wasDriver: false });

    const batch = gate.onIdle({
      selfDisplayName: 'Agent',
      selfAgentId: 'primary',
      others: [{ displayName: 'Beta', agentId: 'agent_beta000000000', provider: 'anthropic', status: 'idle' }],
    });
    expect(batch?.text).toContain('You are Agent [primary].');
    expect(batch?.text).toContain('[Ada — driver] do X');
    expect(batch?.text).toContain('[Bob] do Y');
  });
});

/**
 * Display names are NOT unique, and the roster was treating them as identity.
 *
 * Found by running it, not by reading it. A live room held two agents both
 * named "Beta" (one recovered from the log, one freshly spawned) plus a second
 * "Alpha" alongside the Alpha being prompted. Asked to list its siblings, the
 * real agent answered: "I am Alpha. The others are: Agent, Beta (appears twice
 * in the roster), Scout, Runner" — it flagged the duplicate Beta as odd and
 * silently omitted the second Alpha altogether, almost certainly reading that
 * line as itself.
 *
 * Nothing about the fleet forbids duplicate names: `spawn_agent` takes any
 * displayName a driver types, and `agentId` is the identity everywhere else in
 * the system. A roster that identifies peers by a non-unique field cannot be
 * acted on — and the moment an agent can address a sibling, that field becomes
 * an address. Carry the id.
 */
describe('the roster distinguishes agents that share a display name', () => {
  const peer = (displayName: string, agentId: string) => ({
    displayName, agentId, provider: 'anthropic', status: 'idle',
  });

  it('names the id of every peer, so two agents called Beta are distinguishable', () => {
    const gate = createTurnGate();
    const roster = {
      selfDisplayName: 'Alpha',
      selfAgentId: 'agent_aaaaaaaaaaaa',
      others: [peer('Beta', 'agent_bbbbbbbbbbbb'), peer('Beta', 'agent_cccccccccccc')],
    };

    const batch = gate.submit({ seq: 1, displayName: 'Ada', text: 'go', wasDriver: true }, roster);

    expect(batch?.text).toContain('agent_bbbbbbbbbbbb');
    expect(batch?.text).toContain('agent_cccccccccccc');
  });

  it('names the recipient by id too, so an agent cannot mistake a namesake for itself', () => {
    const gate = createTurnGate();
    const roster = {
      selfDisplayName: 'Alpha',
      selfAgentId: 'agent_aaaaaaaaaaaa',
      others: [peer('Alpha', 'agent_dddddddddddd')],
    };

    const batch = gate.submit({ seq: 1, displayName: 'Ada', text: 'go', wasDriver: true }, roster);

    expect(batch?.text).toContain('agent_aaaaaaaaaaaa');
    expect(batch?.text).toContain('agent_dddddddddddd');
  });
});
