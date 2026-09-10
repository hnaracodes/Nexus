import { beforeEach, describe, expect, it } from 'vitest';
import type { UnsequencedEvent } from '@nexus/protocol/events';
import { createPermissionGate } from '../../src/server/permissions.js';
import { createApprovalQueue } from '../../src/server/approvalQueue.js';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';

/**
 * `permission_requested` must be emitted SYNCHRONOUSLY by `request()` whenever
 * the request is immediately visible — which is every request in a
 * single-agent room, and every request in a fleet with a free approval slot.
 *
 * Phase 12's visibility seam (D3) originally expressed admission as a Promise.
 * Its own comment claimed the default was "byte-identical to before this seam
 * existed"; it was not. `Promise.resolve()` still defers by a microtask, so the
 * emit moved from inside `request()` to after it returned. Nothing type-checked
 * differently and the unit tests still passed — but the server suite went
 * FLAKY, with a different set of socket tests failing on each run, because
 * every caller that had been able to rely on the event existing before the next
 * synchronous statement no longer could.
 *
 * That is why this file asserts on ORDERING rather than on eventual delivery: a
 * test that awaits a tick would pass against exactly the code that broke the
 * suite.
 */

beforeEach(() => {
  __resetRooms();
});

function room() {
  return createRoom({ apiKey: 'sk-ant-TESTONLY', cwd: '/tmp', repoUrl: null });
}

describe('the gate surfaces a visible request synchronously', () => {
  it('emits permission_requested before request() returns, with no queue', () => {
    const emitted: UnsequencedEvent[] = [];
    const gate = createPermissionGate(room(), (e) => emitted.push(e));

    void gate.request('Bash', { command: 'ls' });

    // No await anywhere above this line.
    expect(emitted.map((e) => e.type)).toEqual(['permission_requested']);
  });

  it('emits synchronously through a real queue while a slot is free', () => {
    const emitted: UnsequencedEvent[] = [];
    const queue = createApprovalQueue({ capacity: 2 });
    const gate = createPermissionGate(room(), (e) => emitted.push(e), {
      visibility: {
        admit: (requestId, toolName, surface) => queue.admit('primary', requestId, toolName, surface),
        release: (requestId) => queue.release(requestId),
      },
    });

    void gate.request('Bash', { command: 'ls' });

    expect(emitted.map((e) => e.type)).toEqual(['permission_requested']);
  });

  it('does NOT emit for a request held behind a full queue', () => {
    // The other half of D3: a queued request is not yet on the clock and has
    // not been shown to anyone, so there is nothing for the log to say
    // happened yet.
    const emitted: UnsequencedEvent[] = [];
    const queue = createApprovalQueue({ capacity: 1 });
    const gate = createPermissionGate(room(), (e) => emitted.push(e), {
      visibility: {
        admit: (requestId, toolName, surface) => queue.admit('primary', requestId, toolName, surface),
        release: (requestId) => queue.release(requestId),
      },
    });

    void gate.request('Bash', { command: 'first' });
    void gate.request('Bash', { command: 'second' });

    expect(emitted.filter((e) => e.type === 'permission_requested')).toHaveLength(1);
  });
});
