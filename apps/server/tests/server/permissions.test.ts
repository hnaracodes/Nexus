import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_APPROVE, createPermissionGate } from '../../src/server/permissions.js';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';
import type { Room } from '../../src/server/rooms.js';
import type { UnsequencedEvent } from '@nexus/protocol/events';

let room: Room;
let events: UnsequencedEvent[];

beforeEach(() => {
  __resetRooms();
  events = [];
  room = createRoom({
    apiKey: 'sk-ant-api03-TESTONLY-not-a-real-key',
    cwd: '/tmp',
    repoUrl: null,
  });
});

const gate = (timeoutMs = 120_000) =>
  createPermissionGate(room, (event) => events.push(event), { timeoutMs });

const requested = () => events.filter((e) => e.type === 'permission_requested');
const decided = () => events.filter((e) => e.type === 'permission_decided');

describe('auto-approval', () => {
  it('approves read-only tools without asking the room', async () => {
    const decision = await gate().request('Read', { file_path: '/etc/hosts' });
    expect(decision.decision).toBe('allow');
    expect(decision.via).toBe('auto_approved');
    expect(requested()).toHaveLength(0);
    expect(decided()).toHaveLength(1);
  });

  it('covers exactly the intended read-only set', () => {
    expect([...AUTO_APPROVE].sort()).toEqual(
      ['Glob', 'Grep', 'NotebookRead', 'Read', 'TodoWrite'].sort(),
    );
    expect(AUTO_APPROVE.has('Bash')).toBe(false);
    expect(AUTO_APPROVE.has('Write')).toBe(false);
    expect(AUTO_APPROVE.has('Edit')).toBe(false);
  });
});

describe('room-wide decisions', () => {
  it('suspends on a risky tool and broadcasts a request', async () => {
    const g = gate();
    const pending = g.request('Bash', { command: 'rm -rf /' });
    await Promise.resolve();

    expect(requested()).toHaveLength(1);
    expect(requested()[0]).toMatchObject({ toolName: 'Bash' });
    expect(g.pendingIds()).toHaveLength(1);

    g.resolve(g.pendingIds()[0] as string, {
      decision: 'deny',
      participantId: 'p_grace',
      displayName: 'Grace',
      via: 'first_response',
      reason: 'absolutely not',
    });

    const decision = await pending;
    expect(decision.decision).toBe('deny');
    expect(decision.displayName).toBe('Grace');
    expect(decision.reason).toBe('absolutely not');
  });

  it('records the decision in the log with a name attached', async () => {
    const g = gate();
    const pending = g.request('Write', { file_path: '/tmp/x' });
    await Promise.resolve();
    g.resolve(g.pendingIds()[0] as string, {
      decision: 'allow',
      participantId: 'p_ada',
      displayName: 'Ada',
      via: 'first_response',
      reason: null,
    });
    await pending;

    expect(decided()[0]).toMatchObject({
      type: 'permission_decided',
      decision: 'allow',
      displayName: 'Ada',
      via: 'first_response',
    });
  });

  it('first response wins — a later opposite vote is ignored', async () => {
    const g = gate();
    const pending = g.request('Bash', { command: 'ls' });
    await Promise.resolve();
    const id = g.pendingIds()[0] as string;

    expect(
      g.resolve(id, {
        decision: 'allow',
        participantId: 'p_ada',
        displayName: 'Ada',
        via: 'first_response',
        reason: null,
      }),
    ).toBe(true);
    expect(
      g.resolve(id, {
        decision: 'deny',
        participantId: 'p_grace',
        displayName: 'Grace',
        via: 'first_response',
        reason: 'too late',
      }),
    ).toBe(false);

    expect((await pending).displayName).toBe('Ada');
    expect(decided()).toHaveLength(1);
  });

  it('ignores a decision for an unknown request id', () => {
    expect(
      gate().resolve('req_nonexistent', {
        decision: 'allow',
        participantId: 'p_ada',
        displayName: 'Ada',
        via: 'first_response',
        reason: null,
      }),
    ).toBe(false);
  });
});

describe('timeout', () => {
  it('denies rather than hanging forever', async () => {
    vi.useFakeTimers();
    const g = gate(120_000);
    const pending = g.request('Bash', { command: 'sudo reboot' });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(120_001);
    const decision = await pending;

    expect(decision.decision).toBe('deny');
    expect(decision.via).toBe('timeout');
    expect(decision.participantId).toBeNull();
    expect(g.pendingIds()).toHaveLength(0);
    vi.useRealTimers();
  });

  it('publishes an expiresAt the client can count down from', async () => {
    const g = gate(120_000);
    void g.request('Bash', { command: 'ls' });
    await Promise.resolve();
    expect((requested()[0] as { expiresAt: number }).expiresAt).toBeGreaterThan(Date.now());
  });
});
