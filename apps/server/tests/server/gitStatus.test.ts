import { beforeEach, describe, expect, it } from 'vitest';
import type { GitRunner } from '../../src/server/publish.js';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';
import { getGitDiff, getGitStatus, parsePorcelainStatus } from '../../src/server/gitStatus.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

beforeEach(() => __resetRooms());

function makeRoom(cwd = '/work/room1') {
  return createRoom({ apiKey: KEY, cwd, repoUrl: null });
}

function fakeGit(opts: {
  isRepo?: boolean;
  statusOutput?: string;
  diffOutput?: string;
  failStatus?: { stderr: string };
}): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    if (args.includes('--is-inside-work-tree')) {
      if (opts.isRepo === false) {
        throw Object.assign(new Error('fatal: not a git repository'), {
          stderr: 'fatal: not a git repository',
        });
      }
      return { stdout: 'true\n' };
    }
    if (args.includes('status')) {
      if (opts.failStatus !== undefined) {
        throw Object.assign(new Error('boom'), { stderr: opts.failStatus.stderr });
      }
      return { stdout: opts.statusOutput ?? '' };
    }
    if (args.includes('diff')) {
      return { stdout: opts.diffOutput ?? '' };
    }
    throw new Error(`test: unexpected git call: ${args.join(' ')}`);
  };
  return { git, calls };
}

describe('parsePorcelainStatus', () => {
  it('parses ordinary modified and untracked entries', () => {
    const output = [' M a.txt', '?? new.txt'].join('\0') + '\0';
    expect(parsePorcelainStatus(output)).toEqual([
      { path: 'a.txt', status: ' M' },
      { path: 'new.txt', status: '??' },
    ]);
  });

  it('parses a rename as two consecutive NUL fields: new path, then origin path', () => {
    const output = ['R  renamed-to.txt', 'renamed-from.txt'].join('\0') + '\0';
    expect(parsePorcelainStatus(output)).toEqual([
      { path: 'renamed-to.txt', status: 'R ', from: 'renamed-from.txt' },
    ]);
  });

  it('handles a filename containing a quote, a backslash and a space, unquoted (because of -z)', () => {
    const path = 'say"hi\\ file.txt';
    const output = ` M ${path}\0`;
    expect(parsePorcelainStatus(output)).toEqual([{ path, status: ' M' }]);
  });

  it('returns nothing for empty output', () => {
    expect(parsePorcelainStatus('')).toEqual([]);
  });
});

describe('getGitStatus', () => {
  it('calls status with -z and returns the parsed entries', async () => {
    const fake = fakeGit({ statusOutput: ' M a.txt\0' });
    const result = await getGitStatus(makeRoom(), { git: fake.git });
    expect(result).toEqual({ entries: [{ path: 'a.txt', status: ' M' }] });

    const statusCall = fake.calls.find((args) => args.includes('status'));
    expect(statusCall).toBeDefined();
    expect(statusCall).toContain('-z');
    expect(statusCall).toContain('--porcelain=v1');
    expect(statusCall?.[0]).toBe('-C');
  });

  it('returns no entries, without error, when the working directory is not a git repo', async () => {
    const fake = fakeGit({ isRepo: false });
    const result = await getGitStatus(makeRoom(), { git: fake.git });
    expect(result).toEqual({ entries: [] });
    expect(fake.calls.some((args) => args.includes('status'))).toBe(false);
  });

  it('propagates a redacted error message rather than raw stderr on a genuine git failure', async () => {
    const fake = fakeGit({
      isRepo: true,
      failStatus: { stderr: 'fatal: some low-level failure' },
    });
    await expect(getGitStatus(makeRoom(), { git: fake.git })).rejects.toThrow(/status/i);
  });
});

describe('getGitDiff', () => {
  it('diffs a single path against HEAD, with -- before the path', async () => {
    const fake = fakeGit({ diffOutput: 'diff --git a/x b/x\n' });
    const result = await getGitDiff(makeRoom(), 'src/x.ts', { git: fake.git });
    expect(result).toBe('diff --git a/x b/x\n');

    const diffCall = fake.calls.find((args) => args.includes('diff'));
    expect(diffCall).toContain('HEAD');
    const dashDashIndex = diffCall?.indexOf('--') ?? -1;
    const pathIndex = diffCall?.indexOf('src/x.ts') ?? -1;
    expect(dashDashIndex).toBeGreaterThanOrEqual(0);
    expect(pathIndex).toBeGreaterThan(dashDashIndex);
  });

  it('never lets a room-supplied path be read as a git option', async () => {
    const fake = fakeGit({ diffOutput: '' });
    await getGitDiff(makeRoom(), '--upload-pack=evil', { git: fake.git });
    const diffCall = fake.calls.find((args) => args.includes('diff')) ?? [];
    const dashDashIndex = diffCall.indexOf('--');
    const pathIndex = diffCall.indexOf('--upload-pack=evil');
    expect(dashDashIndex).toBeGreaterThanOrEqual(0);
    expect(pathIndex).toBe(dashDashIndex + 1);
  });

  it('returns an empty diff, without error, when the working directory is not a git repo', async () => {
    const fake = fakeGit({ isRepo: false });
    const result = await getGitDiff(makeRoom(), 'x.ts', { git: fake.git });
    expect(result).toBe('');
  });
});
