import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { UnsequencedEvent } from '@syncode/protocol/events';
import type { Decision, PermissionGate } from '../../../src/server/permissions.js';
import { __resetRooms, createRoom } from '../../../src/server/rooms.js';
import type { Room } from '../../../src/server/rooms.js';
import { buildSynCodeTools, dispatchToolCall } from '../../../src/server/runtime/tools.js';
import type { EmitFn, ToolContext } from '../../../src/server/runtime/tools.js';

/**
 * The choke point is the whole point of this file (see `tools.ts`'s own
 * header): a provider adapter must have exactly one way to run a tool, and
 * that way must gate before it runs. So the tests that matter most here
 * assert the FILESYSTEM, not a mock — a stub that merely records "execute was
 * not called" cannot catch a dispatcher that reaches around itself and calls
 * `tool.execute` directly.
 */

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

function allowGate(): PermissionGate {
  return {
    request: async (): Promise<Decision> => ({
      decision: 'allow',
      participantId: 'p_ada',
      displayName: 'Ada',
      via: 'first_response',
      reason: null,
    }),
    resolve: () => false,
    pendingIds: () => [],
  };
}

function denyGate(reason = 'The room said no.'): PermissionGate {
  return {
    request: async (): Promise<Decision> => ({
      decision: 'deny',
      participantId: 'p_grace',
      displayName: 'Grace',
      via: 'first_response',
      reason,
    }),
    resolve: () => false,
    pendingIds: () => [],
  };
}

let room: Room;
let cwd: string;
let events: UnsequencedEvent[];
let emit: EmitFn;

beforeEach(() => {
  __resetRooms();
  cwd = mkdtempSync(join(tmpdir(), 'nexus-tools-'));
  room = createRoom({ apiKey: KEY, cwd, repoUrl: null });
  events = [];
  emit = (event) => events.push(event);
});

function ctx(): ToolContext {
  return { room, emit };
}

describe('dispatchToolCall — the choke point', () => {
  it('a gate that denies write_file leaves the filesystem untouched', async () => {
    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate: denyGate('absolutely not'),
      emit,
      call: { toolUseId: 'tu_1', name: 'write_file', input: { path: 'new.txt', content: 'hello' } },
      ctx: ctx(),
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('absolutely not');
    // The assertion that matters: the filesystem, not the mock's call count.
    expect(existsSync(join(cwd, 'new.txt'))).toBe(false);
  });

  it('a gate that denies run_command never runs it — proved by an observable side effect', async () => {
    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate: denyGate(),
      emit,
      call: { toolUseId: 'tu_2', name: 'run_command', input: { command: 'touch sentinel.txt' } },
      ctx: ctx(),
    });

    expect(result.isError).toBe(true);
    expect(existsSync(join(cwd, 'sentinel.txt'))).toBe(false);
  });

  it('emits tool_start and tool_result, both carrying toolUseId and toolName, on a denial', async () => {
    await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate: denyGate('no'),
      emit,
      call: { toolUseId: 'tu_3', name: 'write_file', input: { path: 'x.txt', content: 'x' } },
      ctx: ctx(),
    });

    expect(events.find((e) => e.type === 'tool_start')).toMatchObject({
      toolUseId: 'tu_3',
      toolName: 'write_file',
    });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      toolUseId: 'tu_3',
      toolName: 'write_file',
      isError: true,
    });
  });

  it('an unknown tool name produces an error RESULT, never a thrown exception', async () => {
    await expect(
      dispatchToolCall({
        tools: buildSynCodeTools(room),
        gate: allowGate(),
        emit,
        call: { toolUseId: 'tu_4', name: 'no_such_tool', input: {} },
        ctx: ctx(),
      }),
    ).resolves.toMatchObject({ toolUseId: 'tu_4', isError: true });
  });

  it('never asks the gate about a tool name it does not recognise', async () => {
    let requested = false;
    const spyGate: PermissionGate = {
      request: async (): Promise<Decision> => {
        requested = true;
        return { decision: 'allow', participantId: null, displayName: null, via: 'first_response', reason: null };
      },
      resolve: () => false,
      pendingIds: () => [],
    };

    await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate: spyGate,
      emit,
      call: { toolUseId: 'tu_5', name: 'no_such_tool', input: {} },
      ctx: ctx(),
    });

    expect(requested).toBe(false);
  });

  it('an allowed call executes for real and returns the tool output', async () => {
    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate: allowGate(),
      emit,
      call: { toolUseId: 'tu_6', name: 'write_file', input: { path: 'ok.txt', content: 'hi there' } },
      ctx: ctx(),
    });

    expect(result.isError).toBe(false);
    expect(readFileSync(join(cwd, 'ok.txt'), 'utf8')).toBe('hi there');
  });

  it('a tool that throws becomes an error result, not a thrown exception out of dispatchToolCall', async () => {
    await expect(
      dispatchToolCall({
        tools: buildSynCodeTools(room),
        gate: allowGate(),
        emit,
        // edit_file on a file that does not exist throws inside execute().
        call: { toolUseId: 'tu_7', name: 'edit_file', input: { path: 'missing.txt', oldText: 'a', newText: 'b' } },
        ctx: ctx(),
      }),
    ).resolves.toMatchObject({ isError: true });
  });
});

describe('read_file', () => {
  it('reads a file inside the workspace', async () => {
    writeFileSync(join(cwd, 'hello.txt'), 'hello world', 'utf8');
    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate: allowGate(),
      emit,
      call: { toolUseId: 'tu_r1', name: 'read_file', input: { path: 'hello.txt' } },
      ctx: ctx(),
    });
    expect(result.isError).toBe(false);
    expect(result.output).toBe('hello world');
  });

  it('is refused for a path that escapes the workspace root', async () => {
    // Ten levels of `..` clears any tmp-dir depth and lands exactly on
    // `/etc/passwd`, a real file — so this proves the path was REFUSED, not
    // merely that a relative guess happened not to exist.
    //
    // Phase 15 changed WHICH layer refuses it, and the assertion moved with
    // that. The sandbox (`sandbox.ts`) now runs ahead of the gate and rejects
    // it first, so the message is its "outside the room", not the workspace
    // jail's "outside the workspace". The jail is still there and still
    // correct — it is now the second of two nets rather than the first, and
    // this test deliberately asserts on the boundary being enforced rather
    // than on which net caught it, so a future re-ordering of the two does not
    // read as a regression.
    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate: allowGate(),
      emit,
      call: {
        toolUseId: 'tu_r2',
        name: 'read_file',
        input: { path: '../../../../../../../../../../etc/passwd' },
      },
      ctx: ctx(),
    });
    expect(result.isError).toBe(true);
    expect(result.output.toLowerCase()).toMatch(/outside the (room|workspace)/);
  });
});

describe('list_files', () => {
  it('lists the workspace root by default', async () => {
    writeFileSync(join(cwd, 'a.txt'), 'a', 'utf8');
    mkdirSync(join(cwd, 'sub'));
    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate: allowGate(),
      emit,
      call: { toolUseId: 'tu_l1', name: 'list_files', input: {} },
      ctx: ctx(),
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('a.txt');
    expect(result.output).toContain('sub/');
  });
});

describe('search_files', () => {
  it('finds a pattern in file contents under the given path', async () => {
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'a.ts'), 'export const needle = 1;', 'utf8');
    writeFileSync(join(cwd, 'src', 'b.ts'), 'export const nothing = 2;', 'utf8');
    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate: allowGate(),
      emit,
      call: { toolUseId: 'tu_s1', name: 'search_files', input: { pattern: 'needle' } },
      ctx: ctx(),
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('src/a.ts');
    expect(result.output).not.toContain('src/b.ts');
  });
});

describe('edit_file', () => {
  it('replaces the one occurrence of oldText', async () => {
    writeFileSync(join(cwd, 'f.txt'), 'one two three', 'utf8');
    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate: allowGate(),
      emit,
      call: { toolUseId: 'tu_e1', name: 'edit_file', input: { path: 'f.txt', oldText: 'two', newText: 'TWO' } },
      ctx: ctx(),
    });
    expect(result.isError).toBe(false);
    expect(readFileSync(join(cwd, 'f.txt'), 'utf8')).toBe('one TWO three');
  });

  it('errors, and writes nothing, when oldText is absent', async () => {
    writeFileSync(join(cwd, 'f.txt'), 'one two three', 'utf8');
    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate: allowGate(),
      emit,
      call: { toolUseId: 'tu_e2', name: 'edit_file', input: { path: 'f.txt', oldText: 'zzz', newText: 'TWO' } },
      ctx: ctx(),
    });
    expect(result.isError).toBe(true);
    expect(readFileSync(join(cwd, 'f.txt'), 'utf8')).toBe('one two three');
  });

  it('errors, and writes nothing, when oldText is ambiguous', async () => {
    writeFileSync(join(cwd, 'f.txt'), 'two two', 'utf8');
    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate: allowGate(),
      emit,
      call: { toolUseId: 'tu_e3', name: 'edit_file', input: { path: 'f.txt', oldText: 'two', newText: 'X' } },
      ctx: ctx(),
    });
    expect(result.isError).toBe(true);
    expect(readFileSync(join(cwd, 'f.txt'), 'utf8')).toBe('two two');
  });
});

describe('write_file', () => {
  it('refuses to create a file whose containing directory does not exist', async () => {
    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate: allowGate(),
      emit,
      call: { toolUseId: 'tu_w1', name: 'write_file', input: { path: 'nosuch/dir/file.txt', content: 'x' } },
      ctx: ctx(),
    });
    expect(result.isError).toBe(true);
    expect(existsSync(join(cwd, 'nosuch'))).toBe(false);
  });

  it('is refused by the jail for a new file path that escapes the workspace root', async () => {
    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate: allowGate(),
      emit,
      call: { toolUseId: 'tu_w2', name: 'write_file', input: { path: '../escaped.txt', content: 'x' } },
      ctx: ctx(),
    });
    expect(result.isError).toBe(true);
    expect(existsSync(join(cwd, '..', 'escaped.txt'))).toBe(false);
  });
});

describe('run_command', () => {
  it('runs in room.cwd when allowed', async () => {
    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate: allowGate(),
      emit,
      call: { toolUseId: 'tu_c1', name: 'run_command', input: { command: 'touch made-it.txt' } },
      ctx: ctx(),
    });
    expect(result.isError).toBe(false);
    expect(existsSync(join(cwd, 'made-it.txt'))).toBe(true);
  });
});

describe('publish_pull_request', () => {
  it('is present only for a room with a GitHub binding', () => {
    const withBinding = createRoom({
      apiKey: KEY,
      cwd,
      repoUrl: null,
      github: { installationId: 1, owner: 'octo', repo: 'cat', defaultBranch: 'main' },
    });
    const withoutBinding = room;

    expect(buildSynCodeTools(withBinding).map((t) => t.name)).toContain('publish_pull_request');
    expect(buildSynCodeTools(withoutBinding).map((t) => t.name)).not.toContain('publish_pull_request');
  });

  it('is never readOnly', () => {
    const withBinding = createRoom({
      apiKey: KEY,
      cwd,
      repoUrl: null,
      github: { installationId: 1, owner: 'octo', repo: 'cat', defaultBranch: 'main' },
    });
    const tool = buildSynCodeTools(withBinding).find((t) => t.name === 'publish_pull_request');
    expect(tool?.readOnly).toBe(false);
  });
});

describe('buildSynCodeTools', () => {
  it('every tool is declared exactly once, and readOnly matches isAutoApproved', async () => {
    const { isAutoApproved } = await import('../../../src/server/runtime/autoApprove.js');
    const tools = buildSynCodeTools(room);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of tools) {
      expect(tool.readOnly, tool.name).toBe(isAutoApproved(tool.name));
    }
  });
});
