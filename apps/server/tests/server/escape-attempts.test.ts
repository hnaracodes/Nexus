/**
 * Phase 15's demo bar, run adversarially (`docs/plans` phase 15 — the path
 * sandbox). `sandbox.test.ts` proves `checkPath`/`checkCommand` decide
 * correctly in isolation; this file proves something different and more
 * important: that `dispatchToolCall` — the ONE choke point every non-Claude
 * tool call passes through (`runtime/tools.ts`'s own header) — actually
 * ENFORCES those decisions, in the right order, for real tool calls against a
 * real filesystem.
 *
 * Every test below tries to get out and asserts that it fails. Real temp
 * directories, real files, a real symlink — never a mocked filesystem, because
 * a lexical path check cannot see a symlink that escapes the room and only a
 * real one proves the code under test does.
 *
 * THE ASSERTION THAT MATTERS MOST IN EVERY TEST: a sandboxed path must be
 * refused WITHOUT the room ever being asked to approve it. Each fake gate
 * below RECORDS every call and, if asked, ALWAYS SAYS YES — the worst case a
 * sandbox must survive. So `calls` must stay empty for every attempt that the
 * sandbox denies: if `gate.request` were consulted for a path the sandbox
 * itself refuses, a permissive room (or a participant who simply clicks
 * "allow") could vote its way out of the jail, and a jail with a vote-to-leave
 * door is not a jail. Never weaken this to "the gate said no" — the gate must
 * not be asked the question at all.
 *
 * This file is written against `dispatchToolCall` as it exists today, BEFORE
 * the sandbox is wired into it. Several tests below are therefore expected to
 * fail until that wiring lands — see this session's report for exactly which,
 * and why. That is the point: this file is the target the wiring is built to
 * hit, not a retroactive confirmation that it already does.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { UnsequencedEvent } from '@syncode/protocol/events';
import type { Decision, PermissionGate } from '../../src/server/permissions.js';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';
import type { Room } from '../../src/server/rooms.js';
import { buildSynCodeTools, dispatchToolCall } from '../../src/server/runtime/tools.js';
import type { EmitFn, ToolContext } from '../../src/server/runtime/tools.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

/**
 * A gate that records every call it receives and, unless told otherwise,
 * ALWAYS ALLOWS — the room that would happily rubber-stamp anything. Using
 * this (rather than a gate that denies) is deliberate: it isolates "was the
 * gate asked at all" from "did the gate say yes or no", and it is the asking
 * itself that must not happen for a sandbox-denied path (see the file header).
 */
function recordingGate(decision: Decision['decision'] = 'allow'): {
  gate: PermissionGate;
  calls: Array<{ toolName: string; input: unknown }>;
} {
  const calls: Array<{ toolName: string; input: unknown }> = [];
  return {
    calls,
    gate: {
      request: async (toolName: string, input: unknown): Promise<Decision> => {
        calls.push({ toolName, input });
        return { decision, participantId: 'p_room', displayName: 'The Room', via: 'first_response', reason: null };
      },
      resolve: () => false,
      pendingIds: () => [],
    },
  };
}

let room: Room;
/** The room's jailed working directory — everything under here is "inside". */
let cwd: string;
/** The temp dir containing `cwd` as a child — everything else under here is "outside the room" but still on the real filesystem, for absolute-path and symlink-target fixtures. */
let base: string;
let events: UnsequencedEvent[];
let emit: EmitFn;

beforeEach(() => {
  __resetRooms();
  base = mkdtempSync(join(tmpdir(), 'nexus-escape-'));
  cwd = join(base, 'room');
  mkdirSync(cwd);
  room = createRoom({ apiKey: KEY, cwd, repoUrl: null });
  events = [];
  emit = (event) => events.push(event);
});

function ctx(): ToolContext {
  return { room, emit };
}

describe('read_file cannot be used to escape the room', () => {
  it('refuses an absolute path to a file outside the room, without ever asking the gate', async () => {
    const secretPath = join(base, 'outside-secret.txt');
    writeFileSync(secretPath, 'TOP-SECRET-OUTSIDE-THE-ROOM', 'utf8');
    const { gate, calls } = recordingGate('allow');

    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate,
      emit,
      call: { toolUseId: 'esc_1', name: 'read_file', input: { path: secretPath } },
      ctx: ctx(),
    });

    expect(result.isError).toBe(true);
    expect(result.output).not.toContain('TOP-SECRET-OUTSIDE-THE-ROOM');
    // The assertion that matters most — see the file header.
    expect(calls).toEqual([]);
  });

  it('refuses ~/.ssh/id_rsa spelled as a `..` traversal from inside the room, without asking the gate', async () => {
    // Built with `path.relative`, not a hard-coded run of `..`s, so this
    // lands on the real ~/.ssh/id_rsa regardless of how deep the OS happens
    // to put a temp directory — exactly the traversal an agent instructed to
    // "read ../../../../.ssh/id_rsa" would produce. Read-only: this test only
    // ever calls `existsSync`/`realpathSync`-backed path resolution against
    // the real home directory, and asserts the read is refused — it never
    // asserts on the key's actual contents, so it holds whether or not the
    // machine running it even has an `~/.ssh/id_rsa`.
    const target = join(homedir(), '.ssh', 'id_rsa');
    const traversal = relative(cwd, target);
    const { gate, calls } = recordingGate('allow');

    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate,
      emit,
      call: { toolUseId: 'esc_2', name: 'read_file', input: { path: traversal } },
      ctx: ctx(),
    });

    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('refuses a symlink planted inside the room that points outside it — the case a lexical check cannot see', async () => {
    const secretPath = join(base, 'symlink-target.txt');
    writeFileSync(secretPath, 'SECRET-VIA-SYMLINK', 'utf8');
    // The exact shape a hostile cloned repo would use: a file that LOOKS like
    // an ordinary tracked file when listed, but is a symlink resolving
    // outside the room root.
    symlinkSync(secretPath, join(cwd, 'looks-like-a-normal-file.txt'));
    const { gate, calls } = recordingGate('allow');

    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate,
      emit,
      call: { toolUseId: 'esc_3', name: 'read_file', input: { path: 'looks-like-a-normal-file.txt' } },
      ctx: ctx(),
    });

    expect(result.isError).toBe(true);
    expect(result.output).not.toContain('SECRET-VIA-SYMLINK');
    expect(calls).toEqual([]);
  });

  it('refuses .env at the room root even though it is genuinely inside the workspace jail', async () => {
    // NOT a containment escape — `.env` really is inside `cwd`. This is
    // sandbox.ts's rule 3 (the sensitive-name deny-list), which is the one
    // rule the pre-existing workspace jail (`workspace.ts`) has no concept of
    // at all: it only ever asks "is this inside the room?", never "is this
    // name sensitive even though it is?".
    writeFileSync(join(cwd, '.env'), 'API_KEY=super-secret-value', 'utf8');
    const { gate, calls } = recordingGate('allow');

    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate,
      emit,
      call: { toolUseId: 'esc_4', name: 'read_file', input: { path: '.env' } },
      ctx: ctx(),
    });

    expect(result.isError).toBe(true);
    expect(result.output).not.toContain('super-secret-value');
    expect(calls).toEqual([]);
  });
});

describe('write_file cannot be used to escape the room', () => {
  it('refuses to write outside the room via an absolute path, without asking the gate, and touches nothing', async () => {
    const target = join(base, 'pwned.txt');
    const { gate, calls } = recordingGate('allow');

    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate,
      emit,
      call: { toolUseId: 'esc_5', name: 'write_file', input: { path: target, content: 'pwned' } },
      ctx: ctx(),
    });

    expect(result.isError).toBe(true);
    // The filesystem, not the mock — see tools.test.ts's own header for why.
    expect(existsSync(target)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('refuses to write through a symlink planted inside the room that points outside it', async () => {
    const outsideTarget = join(base, 'was-clean.txt');
    writeFileSync(outsideTarget, 'clean', 'utf8');
    symlinkSync(outsideTarget, join(cwd, 'writable-looking-link.txt'));
    const { gate, calls } = recordingGate('allow');

    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate,
      emit,
      call: {
        toolUseId: 'esc_6',
        name: 'write_file',
        input: { path: 'writable-looking-link.txt', content: 'pwned via symlink' },
      },
      ctx: ctx(),
    });

    expect(result.isError).toBe(true);
    expect(readFileSync(outsideTarget, 'utf8')).toBe('clean');
    expect(calls).toEqual([]);
  });
});

describe('run_command cannot be used to reach outside the room, or a sensitive path inside it', () => {
  it('refuses a command referencing an absolute path outside the room, without asking the gate, and never runs the shell', async () => {
    const secretPath = join(base, 'outside-secret-for-shell.txt');
    writeFileSync(secretPath, 'SHELL-SHOULD-NEVER-SEE-THIS', 'utf8');
    const { gate, calls } = recordingGate('allow');

    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate,
      emit,
      call: { toolUseId: 'esc_7', name: 'run_command', input: { command: `cat ${secretPath}` } },
      ctx: ctx(),
    });

    expect(result.isError).toBe(true);
    expect(result.output).not.toContain('SHELL-SHOULD-NEVER-SEE-THIS');
    expect(calls).toEqual([]);
  });

  it('refuses a command referencing a sensitive name inside the room, spelled with no leading slash or tilde at all', async () => {
    // Deliberately a FAKE key planted inside the room's own tree (a cloned
    // repo can carry one), not the real `~/.ssh/id_rsa` — `run_command`
    // actually execs a shell, and a real private key's bytes have no business
    // ever flowing through a test's captured stdout, even transiently.
    mkdirSync(join(cwd, '.ssh'));
    writeFileSync(join(cwd, '.ssh', 'id_rsa'), 'FAKE-KEY-MATERIAL-FOR-THE-TEST', 'utf8');
    const { gate, calls } = recordingGate('allow');

    const result = await dispatchToolCall({
      tools: buildSynCodeTools(room),
      gate,
      emit,
      call: { toolUseId: 'esc_8', name: 'run_command', input: { command: 'cat .ssh/id_rsa' } },
      ctx: ctx(),
    });

    expect(result.isError).toBe(true);
    expect(result.output).not.toContain('FAKE-KEY-MATERIAL-FOR-THE-TEST');
    expect(calls).toEqual([]);
  });
});
