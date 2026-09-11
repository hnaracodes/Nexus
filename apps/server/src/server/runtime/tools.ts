/**
 * The provider-neutral tool catalogue and its ONE choke point (phase 10).
 *
 * Claude's SDK runs tools itself; the room only sees a hook fire before the
 * SDK does. OpenAI and Gemini do not run tools at all — they emit a call and
 * wait for Nexus to send a result back. That means Nexus owns the execution
 * loop for those providers, and an execution loop Nexus owns is an execution
 * loop Nexus must gate itself, since there is no SDK-side pipeline left to
 * (accidentally or not) enforce it.
 *
 * THE LOAD-BEARING REQUIREMENT: a provider adapter that can execute a tool
 * without passing the room's gate is not an adapter, it is a hole. So this
 * module is built so that is structurally hard to do by accident:
 *
 *   - Every `NexusTool.execute` is a plain function on a plain object. Nothing
 *     stops a careless adapter from calling `tool.execute(...)` directly — TS
 *     cannot enforce "call this other function instead" — but the ONLY
 *     function this module exports that is meant to run a tool is
 *     `dispatchToolCall`, and it is the only one documented, tested and
 *     wired into the runtimes that come after this file. An adapter that
 *     reaches around it is doing something visibly wrong in review, not
 *     something the type system quietly allowed.
 *   - `dispatchToolCall` gates BEFORE it executes, always, with no branch
 *     that skips `gate.request` for a tool it recognises as "probably safe" —
 *     that shortcut is what `isAutoApproved` (`./autoApprove.js`) is for, and
 *     it lives entirely inside the gate, not here. This file does not know
 *     and does not ask whether a tool is auto-approved; every call goes
 *     through `gate.request`, which answers instantly for a read-only one.
 *
 * All filesystem-touching tools resolve paths through workspace.ts's existing
 * jail (`resolveWorkspacePath` / `listTree` / `readWorkspaceFile`) rather than
 * a new one — that jail already handles the hard case (a hostile cloned repo
 * committing a symlink out of the tree) via `realpathSync` on both sides, and
 * duplicating that reasoning here would be duplicating the one thing in this
 * file most likely to be gotten subtly wrong twice.
 */

import { exec } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import type { NexusEvent, UnsequencedEvent } from '@syncode/protocol/events';
import type { Room } from '../rooms.js';
import type { Decision, PermissionGate } from '../permissions.js';
import { lastPublishedSha } from '../publishTool.js';
import { publishToGithub } from '../publish.js';
import {
  WorkspacePathError,
  listTree,
  readWorkspaceFile,
  resolveWorkspacePath,
} from '../workspace.js';
import type { TreeEntry } from '../workspace.js';
import { isAutoApproved } from './autoApprove.js';
import { checkCommand, checkPath } from '../sandbox.js';

export type EmitFn = (event: UnsequencedEvent) => void;

/**
 * What a tool's `execute` needs to do its job.
 *
 * `readEvents` is optional and defaults to "no history" when a caller omits
 * it: only `publish_pull_request` needs it (to find the room's own last
 * published commit, I3 — state derived from the log, never held in a
 * variable), and every other tool ignores it entirely. Mirrors
 * `AgentDeps.readEvents` in `agent.ts` for the identical reason.
 */
export interface ToolContext {
  room: Room;
  emit: EmitFn;
  readEvents?: () => NexusEvent[];
}

export interface NexusTool {
  name: string;
  description: string;
  /** JSON Schema, draft-07 compatible — handed to the provider as-is. */
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  execute(input: unknown, ctx: ToolContext): Promise<string>;
}

// --- shared helpers ----------------------------------------------------------

/**
 * Every tool result is capped, unconditionally, in `dispatchToolCall` — see
 * the comment there. This is ALSO applied inside individual tools ahead of
 * that final cap so a tool's own error messages stay a sane length even when
 * inspected directly in a test; capping twice is a no-op the second time.
 */
const MAX_TOOL_OUTPUT_CHARS = 100_000;

function capOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const omitted = text.length - MAX_TOOL_OUTPUT_CHARS;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[truncated: ${omitted} more characters omitted]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(input: unknown, field: string): string {
  const value = isRecord(input) ? input[field] : undefined;
  if (typeof value !== 'string') {
    throw new Error(`"${field}" must be a string.`);
  }
  return value;
}

function optionalString(input: unknown, field: string): string | undefined {
  const value = isRecord(input) ? input[field] : undefined;
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`"${field}" must be a string.`);
  }
  return value;
}

// --- read_file ---------------------------------------------------------------

const readFileTool: NexusTool = {
  name: 'read_file',
  description:
    "Read a file's contents from the room's working directory. The path must " +
    'stay inside the workspace and be given relative to its root.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file, relative to the workspace root.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  readOnly: isAutoApproved('read_file'),
  async execute(input, ctx) {
    const path = requireString(input, 'path');
    // `readWorkspaceFile` calls `resolveWorkspacePath` internally — this is
    // the jail reuse the module header describes. A `WorkspacePathError` (bad
    // path, or one that escapes the root) propagates out of `execute` and is
    // turned into an error tool result by `dispatchToolCall`, never a thrown
    // exception that reaches an adapter.
    const result = readWorkspaceFile(ctx.room, path);
    if (result.kind === 'too_large') {
      return `${path} is ${result.size} bytes, over the 1 MiB limit for a full read.`;
    }
    if (result.kind === 'binary') {
      return `${path} looks like a binary file (${result.size} bytes) and cannot be read as text.`;
    }
    return capOutput(result.content);
  },
};

// --- list_files ---------------------------------------------------------------

const listFilesTool: NexusTool = {
  name: 'list_files',
  description:
    'List one level of a directory in the room\'s working directory. Omit `path` ' +
    'to list the workspace root. Not recursive — list a subdirectory to descend into it.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory to list, relative to the workspace root. Defaults to the root.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  readOnly: isAutoApproved('list_files'),
  async execute(input, ctx) {
    const path = optionalString(input, 'path') ?? '';
    const entries = listTree(ctx.room, path);
    if (entries.length === 0) return '(empty directory)';
    const lines = entries.map((entry) =>
      entry.type === 'directory' ? `${entry.path}/` : `${entry.path}\t${entry.size ?? 0} bytes`,
    );
    return capOutput(lines.join('\n'));
  },
};

// --- search_files ---------------------------------------------------------------

/** Bounds on the walk itself, independent of `capOutput` — a huge repository
 *  must not turn one search into an unbounded directory crawl before the
 *  string cap ever gets a chance to apply. */
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_FILES_SCANNED = 5000;
/** Files bigger than this are skipped rather than read whole into memory just
 *  to test a regex against them — matches `workspace.ts`'s own file-read cap. */
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;

interface SearchState {
  matches: string[];
  scanned: number;
}

/**
 * Walks the tree using `listTree` at every level — never a new directory
 * read — so every step of the walk is subject to the SAME jail decisions
 * (denied names, symlink re-jailing) that `listTree` already makes. The one
 * case `listTree` cannot handle is the ENTRY point itself naming a plain
 * file rather than a directory, which is a legitimate search target and is
 * handled by falling back to a single-file check.
 */
function searchFile(room: Room, regex: RegExp, path: string, state: SearchState): void {
  if (state.scanned >= MAX_SEARCH_FILES_SCANNED) return;
  state.scanned += 1;
  const stat = statSync(resolveWorkspacePath(room, path));
  if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) return;
  const read = readWorkspaceFile(room, path);
  if (read.kind === 'text' && regex.test(read.content)) state.matches.push(path);
}

function searchTree(room: Room, regex: RegExp, path: string, state: SearchState): void {
  if (state.matches.length >= MAX_SEARCH_RESULTS || state.scanned >= MAX_SEARCH_FILES_SCANNED) {
    return;
  }
  let entries: TreeEntry[];
  try {
    entries = listTree(room, path);
  } catch (error) {
    if (error instanceof WorkspacePathError && error.code === 'invalid') {
      // Not a directory — the entry point named a plain file. That is a
      // legitimate thing to search, so fall back rather than treat it as an
      // error.
      searchFile(room, regex, path, state);
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (state.matches.length >= MAX_SEARCH_RESULTS || state.scanned >= MAX_SEARCH_FILES_SCANNED) {
      return;
    }
    if (entry.type === 'directory') {
      searchTree(room, regex, entry.path, state);
    } else {
      searchFile(room, regex, entry.path, state);
    }
  }
}

const searchFilesTool: NexusTool = {
  name: 'search_files',
  description:
    'Search file contents under a directory (default: the whole workspace) for a ' +
    'regular expression, and return the paths that match.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'A JavaScript-flavoured regular expression to search file contents for.',
      },
      path: {
        type: 'string',
        description: 'Directory or file to search under, relative to the workspace root.',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  readOnly: isAutoApproved('search_files'),
  async execute(input, ctx) {
    const pattern = requireString(input, 'pattern');
    const path = optionalString(input, 'path') ?? '';
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      throw new Error(`"${pattern}" is not a valid regular expression.`);
    }
    const state: SearchState = { matches: [], scanned: 0 };
    searchTree(ctx.room, regex, path, state);
    if (state.matches.length === 0) return 'No matches.';
    return capOutput(state.matches.join('\n'));
  },
};

// --- write_file ---------------------------------------------------------------

/**
 * Resolve where a `write_file` call should land, using ONLY
 * `resolveWorkspacePath` to make every inside-or-outside-the-jail decision.
 *
 * `resolveWorkspacePath` was built for phase 7's read-only browsing, where a
 * path that doesn't exist is a 404 — it calls `existsSync` and refuses
 * anything absent. Creating a NEW file is exactly that "absent" case, so it
 * cannot be jailed directly. Instead the jail decision is pushed onto the
 * PARENT directory, which — in the ordinary "write a new file into a
 * directory that already exists" shape — DOES exist:
 *
 *   1. Try the full path first. If it already exists (the overwrite case),
 *      `resolveWorkspacePath` already proved it is inside the jail — done.
 *   2. Otherwise, resolve the PARENT the same way. That still goes through
 *      `resolveWorkspacePath`, so an escape attempt like `path: '../evil'`
 *      is refused at this step too (the parent `..` resolves outside the
 *      root, `resolveWorkspacePath` throws 'invalid', and that is NOT the
 *      'not_found' case this function treats as "just needs creating").
 *   3. Append the new file's own name — a single literal path segment with
 *      no separator, no `..`, no NUL — onto the parent's already-real,
 *      already-jailed path. One safe segment appended to a real, in-jail
 *      directory cannot itself produce an escape; this is the exact
 *      reasoning `workspace.ts`'s `listTree` uses when it joins a directory
 *      entry's name onto its already-real parent.
 *
 * Deliberately does NOT create missing intermediate directories: a tool that
 * silently `mkdir -p`s an arbitrary nested path inside a jail is a second
 * piece of path logic with its own escape reasoning to get right, and this
 * phase does not need it — a room's agent can call `run_command('mkdir -p …')`
 * for that, which passes through the SAME gate as everything else here.
 */
function resolveWriteTarget(room: Room, requestedPath: string): string {
  try {
    return resolveWorkspacePath(room, requestedPath);
  } catch (error) {
    if (!(error instanceof WorkspacePathError) || error.code !== 'not_found') throw error;
  }

  const parent = dirname(requestedPath === '' ? '.' : requestedPath);
  const name = basename(requestedPath);

  if (name === '' || name === '.' || name === '..' || name.includes('\0') || name.includes('/')) {
    throw new WorkspacePathError(`"${requestedPath}" is not a valid file name.`, 'invalid');
  }

  let parentReal: string;
  try {
    parentReal = resolveWorkspacePath(room, parent);
  } catch (error) {
    if (error instanceof WorkspacePathError && error.code === 'not_found') {
      throw new WorkspacePathError(
        `Cannot create ${requestedPath}: the containing directory does not exist.`,
        'not_found',
      );
    }
    throw error;
  }

  if (!statSync(parentReal).isDirectory()) {
    throw new WorkspacePathError(
      `Cannot create ${requestedPath}: ${parent} is not a directory.`,
      'invalid',
    );
  }

  return resolvePath(parentReal, name);
}

const writeFileTool: NexusTool = {
  name: 'write_file',
  description:
    "Create or overwrite a file in the room's working directory with the given " +
    'content. The containing directory must already exist.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file, relative to the workspace root.' },
      content: { type: 'string', description: 'The full contents to write.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  readOnly: isAutoApproved('write_file'),
  async execute(input, ctx) {
    const path = requireString(input, 'path');
    const content = requireString(input, 'content');
    const target = resolveWriteTarget(ctx.room, path);
    writeFileSync(target, content, 'utf8');
    return `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${path}.`;
  },
};

// --- edit_file ---------------------------------------------------------------

const editFileTool: NexusTool = {
  name: 'edit_file',
  description:
    'Replace an exact, unique occurrence of text in an existing file. Fails if ' +
    '`oldText` is not found, or is not unique.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file, relative to the workspace root.' },
      oldText: { type: 'string', description: 'The exact text to replace. Must appear exactly once.' },
      newText: { type: 'string', description: 'The text to replace it with.' },
    },
    required: ['path', 'oldText', 'newText'],
    additionalProperties: false,
  },
  readOnly: isAutoApproved('edit_file'),
  async execute(input, ctx) {
    const path = requireString(input, 'path');
    const oldText = requireString(input, 'oldText');
    const newText = requireString(input, 'newText');
    if (oldText === '') {
      throw new Error(
        '"oldText" must not be empty — an empty string matches everywhere and is not a valid edit.',
      );
    }

    // Jailed via `resolveWorkspacePath` up front so a WRITE never happens
    // against a path `readWorkspaceFile` hasn't already validated.
    const real = resolveWorkspacePath(ctx.room, path);
    const before = readWorkspaceFile(ctx.room, path);
    if (before.kind !== 'text') {
      throw new Error(
        `Cannot edit ${path}: ${
          before.kind === 'binary' ? 'it is a binary file.' : 'it is larger than the 1 MiB edit limit.'
        }`,
      );
    }

    // Counting via `split` rather than a manual scan handles overlapping
    // candidates the same way `String#replaceAll` would, and is the
    // straightforward way to get an exact non-overlapping occurrence count
    // for a literal (non-regex) substring.
    const occurrences = before.content.split(oldText).length - 1;
    if (occurrences === 0) {
      throw new Error(`"oldText" was not found in ${path}.`);
    }
    if (occurrences > 1) {
      throw new Error(
        `"oldText" appears ${occurrences} times in ${path} — make it unique before editing.`,
      );
    }

    // `String#replace` with a string (not regexp) needle replaces only the
    // FIRST match, which is exactly right once uniqueness is already proven.
    writeFileSync(real, before.content.replace(oldText, newText), 'utf8');
    return `Replaced 1 occurrence in ${path}.`;
  },
};

// --- run_command ---------------------------------------------------------------

/** A single shell command string, not an argv array, is the whole point of
 *  this tool — so it needs a shell, and `exec` (not `execFile`) is the
 *  correct primitive rather than a lexical rewrite of one. */
const execAsync = promisify(exec);

const RUN_COMMAND_TIMEOUT_MS = 30_000;
/** Caps what the CHILD PROCESS may buffer, before `capOutput` ever runs —
 *  `exec` buffers a command's entire stdout/stderr in memory, and without
 *  this a verbose command could OOM the server, not just produce a big
 *  provider request. */
const RUN_COMMAND_MAX_BUFFER = 1024 * 1024;

function formatCommandOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.trim() !== '') parts.push(`stdout:\n${stdout}`);
  if (stderr.trim() !== '') parts.push(`stderr:\n${stderr}`);
  return parts.length === 0 ? '(no output)' : parts.join('\n\n');
}

const runCommandTool: NexusTool = {
  name: 'run_command',
  description: "Run a shell command in the room's working directory.",
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to run, exactly as a shell would read it.' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  readOnly: isAutoApproved('run_command'),
  async execute(input, ctx) {
    const command = requireString(input, 'command');
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: ctx.room.cwd,
        timeout: RUN_COMMAND_TIMEOUT_MS,
        maxBuffer: RUN_COMMAND_MAX_BUFFER,
      });
      return capOutput(formatCommandOutput(stdout, stderr));
    } catch (error) {
      // A failed COMMAND is not a failed TOOL CALL — the tool ran exactly as
      // asked and is reporting what happened, the same way a coding agent's
      // Bash tool reports a non-zero exit in its output rather than as a
      // tool-level error. `dispatchToolCall` still marks this call
      // `isError: false`, because `execute` returned normally.
      const e = error as { stdout?: unknown; stderr?: unknown; message?: unknown; killed?: unknown };
      const stdout = typeof e.stdout === 'string' ? e.stdout : '';
      const stderr = typeof e.stderr === 'string' ? e.stderr : '';
      const reason =
        e.killed === true
          ? `timed out after ${RUN_COMMAND_TIMEOUT_MS / 1000}s`
          : typeof e.message === 'string'
            ? e.message
            : 'failed';
      return capOutput(`Command ${reason}.\n${formatCommandOutput(stdout, stderr)}`);
    }
  },
};

// --- publish_pull_request ---------------------------------------------------

/**
 * `publish_pull_request`, reimplemented as a plain `NexusTool` rather than
 * ported as an MCP server the way Claude gets it (`publishTool.ts`).
 *
 * It CANNOT port that way: the Responses API's `mcp` tool type is HOSTED —
 * OpenAI's own infrastructure calls the remote MCP server directly, and the
 * result never reaches this process (see `runtime/toolGuard.ts`'s header for
 * the full reasoning). A tool the room can never see run is a tool the room
 * can never gate, which is exactly the hole this phase exists to close. So
 * this tool calls the SAME underlying logic in `publish.ts` directly, in the
 * one process that already holds the gate.
 *
 * `readOnly` is NOT set via `isAutoApproved` like every other tool here,
 * deliberately: publishing to someone's GitHub repository must never be
 * auto-approved regardless of what any predicate says, so this is the one
 * tool whose gating is asserted as a literal `false`, not derived.
 */
const publishPullRequestTool: NexusTool = {
  name: 'publish_pull_request',
  description:
    'Publish the current working tree to GitHub as a pull request. Every ' +
    'participant in the room is asked to approve before this runs. Calling it ' +
    'again updates the same pull request rather than opening a second one.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Pull request title. One line, imperative mood.' },
      body: {
        type: 'string',
        description: 'Pull request description: what changed and why, in a few sentences.',
      },
    },
    required: ['title', 'body'],
    additionalProperties: false,
  },
  readOnly: false,
  async execute(input, ctx) {
    const binding = ctx.room.github;
    if (binding === null) {
      // Unreachable through `buildNexusTools`, which only includes this tool
      // for a room with a binding — guarded anyway so a caller that mismatches
      // `ctx.room` against the tool list gets a clear message, not a
      // property-access crash three calls deep into `publish.ts`.
      throw new Error('This room has no GitHub repository connected.');
    }
    const title = requireString(input, 'title');
    const body = requireString(input, 'body');
    const readEvents = ctx.readEvents ?? ((): NexusEvent[] => []);

    const result = await publishToGithub({
      binding,
      cwd: ctx.room.cwd,
      roomId: ctx.room.id,
      title,
      body,
      lastPublishedSha: lastPublishedSha(readEvents()),
    });

    // Logged exactly as the Claude MCP path logs it, so "what did this room
    // ship" is answerable from the log alone regardless of which provider
    // ran the agent (I3).
    ctx.emit({
      type: 'github_published',
      prUrl: result.prUrl,
      prNumber: result.prNumber,
      branch: result.branch,
      commitSha: result.commitSha,
      filesChanged: result.filesChanged,
      created: result.created,
    });

    return capOutput(
      `${result.created ? 'Opened' : 'Updated'} pull request #${result.prNumber} ` +
        `(${result.filesChanged} file(s) changed) on branch ${result.branch}: ${result.prUrl}`,
    );
  },
};

// --- catalogue ---------------------------------------------------------------

/**
 * A FUNCTION, not a const: `publish_pull_request` only exists for a room with
 * a GitHub binding, mirroring `createGithubMcpServer`'s own "null means no
 * tool, not a tool that fails when called" choice.
 */
export function buildNexusTools(room: Room): NexusTool[] {
  const tools: NexusTool[] = [
    readFileTool,
    listFilesTool,
    searchFilesTool,
    writeFileTool,
    editFileTool,
    runCommandTool,
  ];
  if (room.github !== null) tools.push(publishPullRequestTool);
  return tools;
}

// --- the choke point ---------------------------------------------------------

export interface ToolCallResult {
  toolUseId: string;
  output: string;
  isError: boolean;
}

/**
 * THE only way to run a `NexusTool`. See the module header for why this
 * function existing, alone, is what makes a provider adapter safe to write.
 *
 * Order, matching what Claude's own transcript already looks like
 * (`agent.ts`'s `translate()`): resolve the tool by name; emit `tool_start`
 * (the model's ATTEMPT to call a tool is worth recording whether or not
 * Nexus recognises the name — a hallucinated tool call should be visible in
 * the room, not silently swallowed); gate; execute only on `allow`; emit
 * `tool_result`. Both emitted events carry `toolUseId` and `toolName`, so the
 * transcript lines up with Claude's regardless of which provider is running.
 */

/**
 * The sandbox check, applied to a tool call's input before anything else can
 * act on it (phase 15).
 *
 * Reads `path` and `command` off the input GENERICALLY rather than per tool,
 * so a tool added later is covered the day it is written rather than the day
 * someone remembers to add it here. That fails CLOSED for the two key names
 * this system actually uses to name a filesystem target, which is the right
 * direction for a security check: a new tool that takes a `path` is sandboxed
 * automatically, and one that invents a third spelling is a gap this comment
 * exists to make visible.
 */
function sandboxVerdict(input: unknown, roomCwd: string): { allowed: true } | { allowed: false; reason: string } {
  if (typeof input !== 'object' || input === null) return { allowed: true };
  const record = input as Record<string, unknown>;
  const path = record['path'];
  if (typeof path === 'string') {
    const verdict = checkPath(path, roomCwd);
    if (!verdict.allowed) return verdict;
  }
  const command = record['command'];
  if (typeof command === 'string') {
    const verdict = checkCommand(command, roomCwd);
    if (!verdict.allowed) return verdict;
  }
  return { allowed: true };
}

export async function dispatchToolCall(args: {
  tools: readonly NexusTool[];
  gate: PermissionGate;
  emit: EmitFn;
  call: { toolUseId: string; name: string; input: unknown };
  ctx: ToolContext;
  signal?: AbortSignal;
}): Promise<ToolCallResult> {
  const { tools, gate, emit, call, ctx, signal } = args;

  function finish(output: string, isError: boolean): ToolCallResult {
    const capped = capOutput(output);
    emit({ type: 'tool_result', toolUseId: call.toolUseId, toolName: call.name, isError, output: capped });
    return { toolUseId: call.toolUseId, output: capped, isError };
  }

  const tool = tools.find((candidate) => candidate.name === call.name);

  emit({ type: 'tool_start', toolUseId: call.toolUseId, toolName: call.name, input: call.input });

  if (tool === undefined) {
    // Fed back to the MODEL as an ordinary result, never thrown — a
    // provider's whole turn must survive one bad tool call, the same way
    // Claude survives calling a tool it does not have. Never reaches the
    // gate: there is nothing to approve for a tool that does not exist.
    return finish(`Unknown tool "${call.name}". No such tool is available in this room.`, true);
  }

  /**
   * THE SANDBOX RUNS BEFORE THE GATE, and that ordering is the whole phase.
   *
   * A denied path is refused WITHOUT the room ever being asked, so there is no
   * card to approve and no vote to win. If this check sat after `gate.request`,
   * four people could agree to read `~/.ssh/id_rsa` and the system would let
   * them — which is not a sandbox, it is a suggestion. The room's authority is
   * over what the agent may do INSIDE the boundary; it does not extend to
   * moving the boundary.
   *
   * It is also why this is not simply another `AUTO_APPROVE`-style predicate:
   * auto-approval decides who answers, and this decides whether the question
   * may be asked at all.
   */
  const sandbox = sandboxVerdict(call.input, ctx.room.cwd);
  if (!sandbox.allowed) {
    return finish(sandbox.reason, true);
  }

  const decision: Decision = await gate.request(call.name, call.input, signal);
  if (decision.decision !== 'allow') {
    // WITHOUT executing — the entire point of asking first.
    return finish(decision.reason ?? `The room denied ${call.name}.`, true);
  }

  try {
    const output = await tool.execute(call.input, ctx);
    return finish(output, false);
  } catch (error) {
    // A tool that throws does not kill the turn — the failure becomes the
    // tool's result, exactly like a denial does, so the model can see what
    // went wrong and adapt instead of the whole turn dying.
    return finish(error instanceof Error ? error.message : String(error), true);
  }
}
