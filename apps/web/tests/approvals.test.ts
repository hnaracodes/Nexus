import { describe, expect, it } from 'vitest';
import { deriveApprovals, summarizeInput } from '../src/approvals.js';
import type { NexusEvent } from '@syncode/protocol/events';

function log(...partials: Record<string, unknown>[]): NexusEvent[] {
  return partials.map(
    (p, i) => ({ seq: i + 1, ts: '2026-07-28T00:00:00.000Z', roomId: 'room_a', ...p }) as NexusEvent,
  );
}

describe('deriveApprovals', () => {
  it('opens a pending approval on request', () => {
    const { pending } = deriveApprovals(
      log({
        type: 'permission_requested',
        requestId: 'req_1',
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        expiresAt: 1_800_000_000_000,
      }),
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ requestId: 'req_1', toolName: 'Bash' });
  });

  it('closes it when the matching decision arrives', () => {
    const { pending, settled } = deriveApprovals(
      log(
        {
          type: 'permission_requested',
          requestId: 'req_1',
          toolName: 'Bash',
          input: {},
          expiresAt: 1,
        },
        {
          type: 'permission_decided',
          requestId: 'req_1',
          toolName: 'Bash',
          decision: 'deny',
          participantId: 'p_grace',
          displayName: 'Grace',
          via: 'first_response',
          reason: 'no',
        },
      ),
    );
    expect(pending).toHaveLength(0);
    expect(settled[0]).toMatchObject({ decision: 'deny', displayName: 'Grace' });
  });

  it('leaves unrelated requests pending', () => {
    const { pending } = deriveApprovals(
      log(
        {
          type: 'permission_requested',
          requestId: 'req_1',
          toolName: 'Bash',
          input: {},
          expiresAt: 1,
        },
        {
          type: 'permission_requested',
          requestId: 'req_2',
          toolName: 'Write',
          input: {},
          expiresAt: 1,
        },
        {
          type: 'permission_decided',
          requestId: 'req_1',
          toolName: 'Bash',
          decision: 'allow',
          participantId: null,
          displayName: null,
          via: 'auto_approved',
          reason: null,
        },
      ),
    );
    expect(pending.map((p) => p.requestId)).toEqual(['req_2']);
  });
});

describe('summarizeInput', () => {
  it('renders a bash command readably', () => {
    expect(summarizeInput({ command: 'rm -rf /' })).toContain('rm -rf /');
  });

  it('truncates very long input', () => {
    expect(summarizeInput({ blob: 'x'.repeat(5000) }, 2000)).toHaveLength(2000);
  });
});
