import { describe, expect, it } from 'vitest';
import type { NexusEvent } from '@nexus/protocol/events';
import {
  deriveCurrentFile,
  deriveFileEdits,
  deriveLatestEditSeqByPath,
  deriveTouchedFiles,
  parseFileToolInput,
} from '../workspaceFiles.js';

const ROOM = 'room_fixture';

function ts(seq: number): string {
  return new Date(2026, 6, 28, 0, 0, seq).toISOString();
}

function toolStart(seq: number, toolUseId: string, toolName: string, input: unknown): NexusEvent {
  return { seq, ts: ts(seq), roomId: ROOM, type: 'tool_start', toolUseId, toolName, input };
}

function toolResult(seq: number, toolUseId: string): NexusEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'tool_result',
    toolUseId,
    toolName: 'unused',
    isError: false,
    output: 'ok',
  };
}

describe('parseFileToolInput', () => {
  it('parses a Write input', () => {
    expect(parseFileToolInput('Write', { file_path: 'a.ts', content: 'hi' })).toEqual({
      kind: 'write',
      filePath: 'a.ts',
      content: 'hi',
    });
  });

  it('parses an Edit input', () => {
    expect(parseFileToolInput('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' })).toEqual({
      kind: 'edit',
      filePath: 'a.ts',
      oldString: 'x',
      newString: 'y',
    });
  });

  it('never throws on undefined input', () => {
    expect(parseFileToolInput('Write', undefined)).toBeNull();
  });

  it('never throws on a string input', () => {
    expect(parseFileToolInput('Write', 'not an object')).toBeNull();
  });

  it('returns null on an object missing file_path', () => {
    expect(parseFileToolInput('Write', { content: 'hi' })).toBeNull();
  });

  it('returns null for NotebookEdit — cell-shaped input is not a text diff', () => {
    expect(parseFileToolInput('NotebookEdit', { file_path: 'a.ipynb', new_source: 'x' })).toBeNull();
  });
});

describe('deriveTouchedFiles', () => {
  it('skips malformed tool_start input without throwing', () => {
    const events: NexusEvent[] = [
      toolStart(1, 'tu1', 'Write', undefined),
      toolStart(2, 'tu2', 'Write', 'a string'),
      toolStart(3, 'tu3', 'Write', { content: 'no file_path' }),
    ];
    expect(deriveTouchedFiles(events)).toEqual([]);
  });

  it('lists distinct paths in first-touched order', () => {
    const events: NexusEvent[] = [
      toolStart(1, 'tu1', 'Read', { file_path: 'b.ts' }),
      toolStart(2, 'tu2', 'Write', { file_path: 'a.ts', content: 'x' }),
      toolStart(3, 'tu3', 'Edit', { file_path: 'b.ts', old_string: 'x', new_string: 'y' }),
    ];
    expect(deriveTouchedFiles(events)).toEqual(['b.ts', 'a.ts']);
  });

  it('ignores tools with no file_path field', () => {
    const events: NexusEvent[] = [toolStart(1, 'tu1', 'Bash', { command: 'ls' })];
    expect(deriveTouchedFiles(events)).toEqual([]);
  });
});

describe('deriveCurrentFile', () => {
  it('is null on an empty log', () => {
    expect(deriveCurrentFile([])).toBeNull();
  });

  it('reports the file of an unresolved tool_start', () => {
    const events: NexusEvent[] = [toolStart(1, 'tu1', 'Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' })];
    expect(deriveCurrentFile(events)).toBe('a.ts');
  });

  it('matches tool_result by toolUseId, not by position', () => {
    const events: NexusEvent[] = [
      toolStart(1, 'tu1', 'Read', { file_path: 'a.ts' }),
      toolStart(2, 'tu2', 'Edit', { file_path: 'b.ts', old_string: 'x', new_string: 'y' }),
      toolResult(3, 'tu2'),
    ];
    // tu2 (b.ts) settled; tu1 (a.ts) is still the running one.
    expect(deriveCurrentFile(events)).toBe('a.ts');
  });

  it('falls back to the most recently touched file once idle', () => {
    const events: NexusEvent[] = [
      toolStart(1, 'tu1', 'Write', { file_path: 'a.ts', content: 'x' }),
      toolResult(2, 'tu1'),
      toolStart(3, 'tu2', 'Write', { file_path: 'b.ts', content: 'y' }),
      toolResult(4, 'tu2'),
    ];
    expect(deriveCurrentFile(events)).toBe('b.ts');
  });
});

describe('deriveFileEdits / deriveLatestEditSeqByPath', () => {
  it('collects only well-formed Write/Edit tool_start events', () => {
    const events: NexusEvent[] = [
      toolStart(1, 'tu1', 'Read', { file_path: 'a.ts' }),
      toolStart(2, 'tu2', 'Write', { file_path: 'b.ts', content: 'hi' }),
      toolStart(3, 'tu3', 'Edit', { file_path: 'b.ts', old_string: 'hi', new_string: 'bye' }),
      toolStart(4, 'tu4', 'Bash', { command: 'ls' }),
    ];
    const edits = deriveFileEdits(events);
    expect(edits.map((e) => e.toolUseId)).toEqual(['tu2', 'tu3']);
    expect(deriveLatestEditSeqByPath(events).get('b.ts')).toBe(3);
  });
});
