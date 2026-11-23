import { describe, expect, it } from 'vitest';
import type { SynCodeEvent } from '@syncode/protocol/events';
import type { EditPreview } from '@syncode/protocol/livepreview';
import { deriveGhosts, typingGhostPath, workspaceRelative } from '../ghosts.js';

const T0 = Date.parse('2026-11-23T10:00:00.000Z');
const ts = (ms: number) => new Date(T0 + ms).toISOString();
let seq = 0;
function e(body: Record<string, unknown>, at = 0): SynCodeEvent {
  seq += 1;
  return { seq, ts: ts(at), roomId: 'room_a', ...body } as SynCodeEvent;
}

const CWD = '/home/ada/proj';
const created = () => e({ type: 'room_created', cwd: CWD, repoUrl: null });
const EDIT_INPUT = { file_path: `${CWD}/src/app.ts`, old_string: 'a = 1', new_string: 'a = 2' };
const toolStart = (id = 'toolu_1', input: unknown = EDIT_INPUT, extra: Record<string, unknown> = {}) =>
  e({ type: 'tool_start', toolUseId: id, toolName: 'Edit', input, ...extra });

const streaming: EditPreview = {
  toolUseId: 'toolu_1',
  agentId: 'primary',
  toolName: 'Edit',
  path: `${CWD}/src/app.ts`,
  mode: 'replace',
  hunks: [{ old: 'a = 1', new: 'a =', oldDone: true, newDone: false }],
  replaceAll: false,
  streaming: true,
  truncated: false,
};

describe('workspaceRelative', () => {
  it('strips the room folder, keeps relative paths, refuses outside paths', () => {
    expect(workspaceRelative(`${CWD}/src/a.ts`, CWD)).toBe('src/a.ts');
    expect(workspaceRelative('src/a.ts', CWD)).toBe('src/a.ts');
    expect(workspaceRelative('/etc/passwd', CWD)).toBeNull();
    expect(workspaceRelative(`${CWD}-evil/x.ts`, CWD)).toBeNull();
    expect(workspaceRelative(`${CWD}/../x.ts`, CWD)).toBeNull();
    expect(workspaceRelative('../x.ts', CWD)).toBeNull();
    expect(workspaceRelative(`${CWD}/a.ts`, null)).toBeNull();
  });
});

describe('deriveGhosts', () => {
  it('is typing while the model streams, with a relative path and the agent name', () => {
    const events = [created(), e({ type: 'agent_spawned', agentId: 'primary', provider: 'anthropic', model: null, displayName: 'Coder' })];
    const [ghost] = deriveGhosts(events, { toolu_1: streaming }, T0);
    expect(ghost).toMatchObject({ toolUseId: 'toolu_1', path: 'src/app.ts', phase: 'typing', agentName: 'Coder' });
    expect(typingGhostPath([ghost!])).toBe('src/app.ts');
  });

  it('waits for approval, then lands, then disappears after the highlight', () => {
    const base = [created(), toolStart(), e({ type: 'permission_requested', requestId: 'req_1', toolName: 'Edit', input: EDIT_INPUT, expiresAt: 0, toolUseId: 'toolu_1' })];
    expect(deriveGhosts(base, {}, T0)[0]?.phase).toBe('waiting');
    const decided = [...base, e({ type: 'permission_decided', requestId: 'req_1', toolName: 'Edit', decision: 'allow', participantId: 'p1', displayName: 'Ada', via: 'vote', reason: null })];
    expect(deriveGhosts(decided, {}, T0)[0]?.phase).toBe('applying');
    const landed = [...decided, e({ type: 'tool_result', toolUseId: 'toolu_1', toolName: '', isError: false, output: 'ok' }, 100)];
    expect(deriveGhosts(landed, {}, T0 + 500)[0]?.phase).toBe('landed');
    expect(deriveGhosts(landed, {}, T0 + 100 + 1501)).toEqual([]);
  });

  it('shows who denied it, then fades', () => {
    const events = [
      created(),
      toolStart(),
      e({ type: 'permission_requested', requestId: 'req_1', toolName: 'Edit', input: EDIT_INPUT, expiresAt: 0, toolUseId: 'toolu_1' }),
      e({ type: 'permission_decided', requestId: 'req_1', toolName: 'Edit', decision: 'deny', participantId: 'p2', displayName: 'Bob', via: 'vote', reason: null }, 200),
    ];
    expect(deriveGhosts(events, {}, T0 + 300)[0]).toMatchObject({ phase: 'denied', decidedBy: 'Bob' });
    expect(deriveGhosts(events, {}, T0 + 200 + 2001)).toEqual([]);
  });

  it('the logged input wins over the streamed text once it exists', () => {
    const events = [created(), toolStart('toolu_1', { ...EDIT_INPUT, new_string: 'a = 2 // final' })];
    const [ghost] = deriveGhosts(events, { toolu_1: { ...streaming, streaming: false } }, T0);
    expect(ghost?.preview.hunks[0]?.new).toBe('a = 2 // final');
  });

  it('drops edits outside the room, abandoned previews, and edits the turn never ran', () => {
    expect(deriveGhosts([created()], { toolu_1: { ...streaming, path: '/etc/hosts' } }, T0)).toEqual([]);
    expect(deriveGhosts([created()], {}, T0)).toEqual([]);
    const idleAfter = [created(), toolStart(), e({ type: 'agent_idle' })];
    expect(deriveGhosts(idleAfter, {}, T0)).toEqual([]);
    const otherAgentIdle = [created(), toolStart('toolu_1', EDIT_INPUT, { agentId: 'agent_b' }), e({ type: 'agent_idle' })];
    expect(deriveGhosts(otherAgentIdle, {}, T0)).toHaveLength(1);
  });

  it('ignores tools that do not edit files', () => {
    const events = [created(), e({ type: 'tool_start', toolUseId: 't', toolName: 'Read', input: { file_path: `${CWD}/a.ts` } })];
    expect(deriveGhosts(events, {}, T0)).toEqual([]);
  });
});
