import { describe, expect, it } from 'vitest';
import { applyLiveFrame, previewFromToolStart } from '@syncode/protocol/livepreview';
import type { EditPreview } from '@syncode/protocol/livepreview';

const base: EditPreview = {
  toolUseId: 'toolu_1',
  agentId: 'primary',
  toolName: 'Edit',
  path: null,
  mode: 'replace',
  hunks: [],
  replaceAll: false,
  streaming: true,
  truncated: false,
};

describe('applyLiveFrame', () => {
  it('snapshot, then appends, then complete gives the exact text', () => {
    let state = applyLiveFrame({}, { kind: 'edit_preview', preview: { ...base, path: '/r/a.ts' } });
    state = applyLiveFrame(state, { kind: 'edit_preview_text', toolUseId: 'toolu_1', hunk: 0, field: 'old', text: 'const a' });
    state = applyLiveFrame(state, { kind: 'edit_preview_text', toolUseId: 'toolu_1', hunk: 0, field: 'old', text: ' = 1;' });
    state = applyLiveFrame(state, { kind: 'edit_preview_text', toolUseId: 'toolu_1', hunk: 0, field: 'new', text: 'const a = 2;' });
    state = applyLiveFrame(state, { kind: 'edit_preview_end', toolUseId: 'toolu_1', reason: 'complete' });
    expect(state['toolu_1']).toMatchObject({
      path: '/r/a.ts',
      streaming: false,
      hunks: [{ old: 'const a = 1;', new: 'const a = 2;', oldDone: true, newDone: true }],
    });
  });

  it('text for an unknown preview returns the same object', () => {
    const state = applyLiveFrame({}, { kind: 'edit_preview', preview: base });
    const after = applyLiveFrame(state, { kind: 'edit_preview_text', toolUseId: 'nope', hunk: 0, field: 'new', text: 'x' });
    expect(after).toBe(state);
    expect(applyLiveFrame(state, { kind: 'edit_preview_end', toolUseId: 'nope', reason: 'complete' })).toBe(state);
  });

  it('abandoned removes the preview', () => {
    const state = applyLiveFrame({}, { kind: 'edit_preview', preview: base });
    expect(applyLiveFrame(state, { kind: 'edit_preview_end', toolUseId: 'toolu_1', reason: 'abandoned' })).toEqual({});
  });

  it('an append to a later hunk creates the hunks before it (MultiEdit)', () => {
    let state = applyLiveFrame({}, { kind: 'edit_preview', preview: { ...base, toolName: 'MultiEdit' } });
    state = applyLiveFrame(state, { kind: 'edit_preview_text', toolUseId: 'toolu_1', hunk: 1, field: 'new', text: 'b' });
    expect(state['toolu_1']?.hunks).toEqual([
      { old: '', new: '', oldDone: false, newDone: false },
      { old: '', new: 'b', oldDone: false, newDone: false },
    ]);
  });

  it('never mutates the previous state', () => {
    const state = applyLiveFrame({}, { kind: 'edit_preview', preview: { ...base, hunks: [{ old: '', new: 'a', oldDone: false, newDone: false }] } });
    const frozen = JSON.stringify(state);
    applyLiveFrame(state, { kind: 'edit_preview_text', toolUseId: 'toolu_1', hunk: 0, field: 'new', text: 'b' });
    expect(JSON.stringify(state)).toBe(frozen);
  });
});

describe('previewFromToolStart', () => {
  it('maps Edit, MultiEdit and Write to complete previews', () => {
    expect(
      previewFromToolStart({
        toolUseId: 't',
        toolName: 'Edit',
        input: { file_path: '/r/a.ts', old_string: 'x', new_string: 'y', replace_all: true },
      }),
    ).toMatchObject({ mode: 'replace', replaceAll: true, streaming: false, hunks: [{ old: 'x', new: 'y', oldDone: true, newDone: true }] });
    expect(
      previewFromToolStart({
        toolUseId: 't',
        toolName: 'MultiEdit',
        input: { file_path: '/r/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] },
      })?.hunks.map((h) => [h.old, h.new]),
    ).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(
      previewFromToolStart({ toolUseId: 't', toolName: 'Write', input: { file_path: '/r/n.ts', content: 'hi' }, agentId: 'agent_b' }),
    ).toMatchObject({ mode: 'write', agentId: 'agent_b', hunks: [{ old: '', new: 'hi' }] });
  });

  it('is null for other tools and malformed input', () => {
    expect(previewFromToolStart({ toolUseId: 't', toolName: 'Read', input: { file_path: '/r/a.ts' } })).toBeNull();
    expect(previewFromToolStart({ toolUseId: 't', toolName: 'Edit', input: { old_string: 'x', new_string: 'y' } })).toBeNull();
    expect(previewFromToolStart({ toolUseId: 't', toolName: 'Write', input: 'nope' })).toBeNull();
  });
});
