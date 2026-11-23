import { describe, expect, it } from 'vitest';
import { applyLiveFrame } from '@syncode/protocol/livepreview';
import type { EditPreview, LiveFrame } from '@syncode/protocol/livepreview';
import { createLiveStream } from '../../../src/server/live/liveStream.js';
import type { LiveOutFrame } from '../../../src/server/live/liveStream.js';

/** SDK `stream_event` messages, in the raw Anthropic streaming shape. */
const ev = (event: Record<string, unknown>, parent: string | null = null) => ({
  type: 'stream_event',
  event,
  parent_tool_use_id: parent,
  uuid: 'u',
  session_id: 's',
});
const messageStart = (id = 'msg_1') => ev({ type: 'message_start', message: { id, content: [] } });
const toolStart = (index: number, id: string, name: string) =>
  ev({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } });
const textStart = (index: number) => ev({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
const json = (index: number, partial: string) =>
  ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partial } });
const text = (index: number, t: string) => ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } });
const stop = (index: number) => ev({ type: 'content_block_stop', index });

function chunks(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

function run(messages: unknown[], maxPreviewBytes?: number) {
  const frames: LiveOutFrame[] = [];
  const live = createLiveStream({ agentId: 'agent_a', sink: (f) => frames.push(f), ...(maxPreviewBytes === undefined ? {} : { maxPreviewBytes }) });
  for (const m of messages) live.onSdkMessage(m);
  let previews: Record<string, EditPreview> = {};
  for (const f of frames) if (f.kind !== 'assistant_delta') previews = applyLiveFrame(previews, f as LiveFrame);
  return { frames, previews, live };
}

const EDIT = {
  file_path: '/room/src/app.ts',
  old_string: 'export const greeting = "hi";\n',
  new_string: 'export const greeting = "hello";\nexport const farewell = "bye";\n',
};

describe('createLiveStream', () => {
  it('turns a streamed Edit into frames that fold to exactly the input', () => {
    const { frames, previews } = run([
      messageStart(),
      toolStart(0, 'toolu_1', 'Edit'),
      ...chunks(JSON.stringify(EDIT), 7).map((c) => json(0, c)),
      stop(0),
    ]);
    expect(frames[0]).toMatchObject({ kind: 'edit_preview', preview: { toolUseId: 'toolu_1', agentId: 'agent_a', path: null, streaming: true } });
    expect(previews['toolu_1']).toMatchObject({
      path: '/room/src/app.ts',
      mode: 'replace',
      streaming: false,
      hunks: [{ old: EDIT.old_string, new: EDIT.new_string, oldDone: true, newDone: true }],
    });
    expect(frames.at(-1)).toEqual({ kind: 'edit_preview_end', toolUseId: 'toolu_1', reason: 'complete' });
  });

  it('announces the path as soon as it has streamed in, before any edit text', () => {
    const { frames } = run([messageStart(), toolStart(0, 'toolu_1', 'Edit'), json(0, '{"file_path": "/room/a.ts", "old_')]);
    expect(frames.some((f) => f.kind === 'edit_preview' && f.preview.path === '/room/a.ts')).toBe(true);
  });

  it('streams a Write to hunk 0 in write mode, and MultiEdit to one hunk per edit', () => {
    const write = run([
      messageStart(),
      toolStart(0, 'toolu_w', 'Write'),
      ...chunks(JSON.stringify({ file_path: '/r/n.ts', content: 'line one\nline two\n' }), 5).map((c) => json(0, c)),
      stop(0),
    ]);
    expect(write.previews['toolu_w']).toMatchObject({ mode: 'write', hunks: [{ old: '', new: 'line one\nline two\n' }] });

    const multi = run([
      messageStart(),
      toolStart(0, 'toolu_m', 'MultiEdit'),
      ...chunks(JSON.stringify({ file_path: '/r/a.ts', edits: [{ old_string: 'a b', new_string: 'c d' }, { old_string: 'e', new_string: 'f', replace_all: true }] }), 4).map((c) => json(0, c)),
      stop(0),
    ]);
    expect(multi.previews['toolu_m']?.hunks.map((h) => [h.old, h.new])).toEqual([
      ['a b', 'c d'],
      ['e', 'f'],
    ]);
    expect(multi.previews['toolu_m']?.replaceAll).toBe(true);
  });

  it('streams chat text as assistant_delta under the message id', () => {
    const { frames } = run([messageStart('msg_9'), textStart(0), text(0, 'Hello the'), text(0, 're, wor'), text(0, 'ld.'), stop(0)]);
    const deltas = frames.filter((f) => f.kind === 'assistant_delta');
    expect(deltas.every((d) => d.kind === 'assistant_delta' && d.messageId === 'msg_9')).toBe(true);
    expect(deltas.map((d) => (d.kind === 'assistant_delta' ? d.text : '')).join('')).toBe('Hello there, world.');
  });

  it('previews nothing for tools that do not edit files', () => {
    const { frames } = run([messageStart(), toolStart(0, 'toolu_r', 'Read'), json(0, '{"file_path":"/r/a.ts"}'), stop(0)]);
    expect(frames).toEqual([]);
  });

  it('abandonAll ends an in-flight preview as abandoned', () => {
    const { frames, live } = run([messageStart(), toolStart(0, 'toolu_1', 'Edit'), json(0, '{"file_path":"/r/a.ts","new_string":"par')]);
    expect(live.inFlight().map((p) => p.toolUseId)).toEqual(['toolu_1']);
    live.abandonAll();
    expect(frames.at(-1)).toEqual({ kind: 'edit_preview_end', toolUseId: 'toolu_1', reason: 'abandoned' });
    expect(live.inFlight()).toEqual([]);
  });

  it('never sends a secret the agent types, however it is chunked', () => {
    const secret = 'sk-ant-api03-SECRETSECRETSECRET0123';
    const input = JSON.stringify({ file_path: '/r/.env.example', content: `ANTHROPIC_API_KEY=${secret}\nPORT=8080\n` });
    for (const size of [1, 3, 9]) {
      const { frames, previews } = run([messageStart(), toolStart(0, 'toolu_s', 'Write'), ...chunks(input, size).map((c) => json(0, c)), stop(0)]);
      expect(JSON.stringify(frames)).not.toContain('SECRETSECRET');
      expect(previews['toolu_s']?.hunks[0]?.new).toBe('ANTHROPIC_API_KEY=[REDACTED]\nPORT=8080\n');
    }
  });

  it('stops growing at the size cap and says so', () => {
    const big = 'word '.repeat(400);
    const { previews } = run(
      [messageStart(), toolStart(0, 'toolu_b', 'Write'), ...chunks(JSON.stringify({ file_path: '/r/b.ts', content: big }), 50).map((c) => json(0, c)), stop(0)],
      200,
    );
    expect(previews['toolu_b']?.truncated).toBe(true);
    expect((previews['toolu_b']?.hunks[0]?.new.length ?? 0) <= 205).toBe(true);
  });

  it('carries a subagent parent id onto its preview', () => {
    const { frames } = run([ev({ type: 'message_start', message: { id: 'm' } }, 'toolu_parent'), ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_c', name: 'Edit', input: {} } }, 'toolu_parent')]);
    expect(frames[0]).toMatchObject({ kind: 'edit_preview', preview: { parentToolUseId: 'toolu_parent' } });
  });
});
