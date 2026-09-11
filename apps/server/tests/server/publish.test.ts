/**
 * Tests for `publishToGithub` (plan phase-6.3).
 *
 * Every test runs with NO network and NO real repository: both seams the module
 * exposes — `fetch` and the local `git` invocation — are injected. That is not
 * merely for speed. The two properties most worth pinning here are (a) that a
 * credential never reaches a subprocess and (b) that a partial view of the
 * remote never turns into a mass deletion, and neither is observable against a
 * live GitHub without risking a real repository.
 */

import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setGithubAppConfig } from '../../src/server/github.js';
import { publishToGithub } from '../../src/server/publish.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

/** The installation token the fake GitHub hands back. Must never be seen again. */
const TOKEN = 'ghs_supersecrettokenvalue';

const BINDING = { installationId: 7, owner: 'acme', repo: 'proj', defaultBranch: 'main' };
const ROOM_ID = 'room123';
const CWD = '/work/room123';

interface GhTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

interface Scenario {
  /** What GitHub reports for the base tree. */
  baseTree?: GhTreeEntry[];
  truncated?: boolean;
  /** Head commit of the default branch. */
  headSha?: string;
  /** commit sha -> its tree sha. */
  commitTrees?: Record<string, string>;
  openPulls?: unknown[];
  /** Force a non-2xx on a specific endpoint. */
  status?: Partial<Record<'blobs' | 'trees' | 'refPatch', number>>;
  /** Commit shas GitHub cannot read — a force-push plus GC, or a deleted branch. */
  missingCommits?: string[];
}

interface Recorded {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A fake api.github.com that records every call. Routing is by method + path so
 * the GET of an existing tree and the POST of a new one stay distinguishable.
 */
function fakeGithub(scenario: Scenario = {}) {
  const calls: Recorded[] = [];
  let blobCounter = 0;

  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ url, method, body, headers });

    if (url.includes('/access_tokens')) return jsonResponse({ token: TOKEN });

    if (method === 'GET' && url.includes('/git/ref/heads/')) {
      return jsonResponse({ object: { sha: scenario.headSha ?? 'headcommit' } });
    }
    if (method === 'GET' && url.includes('/git/commits/')) {
      const sha = url.split('/git/commits/')[1] ?? '';
      if (scenario.missingCommits?.includes(sha) === true) {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      return jsonResponse({ sha, tree: { sha: scenario.commitTrees?.[sha] ?? `${sha}-tree` } });
    }
    if (method === 'GET' && url.includes('/git/trees/')) {
      return jsonResponse({
        sha: 'whatever',
        tree: scenario.baseTree ?? [],
        truncated: scenario.truncated === true,
      });
    }
    if (method === 'POST' && url.endsWith('/git/blobs')) {
      if (scenario.status?.blobs !== undefined) {
        return jsonResponse({ message: 'nope' }, scenario.status.blobs);
      }
      blobCounter += 1;
      return jsonResponse({ sha: `uploaded${blobCounter}` });
    }
    if (method === 'POST' && url.endsWith('/git/trees')) {
      if (scenario.status?.trees !== undefined) {
        return jsonResponse({ message: 'Validation Failed' }, scenario.status.trees);
      }
      return jsonResponse({ sha: 'newtree' });
    }
    if (method === 'POST' && url.endsWith('/git/commits')) return jsonResponse({ sha: 'newcommit' });
    if (method === 'PATCH' && url.includes('/git/refs/heads/')) {
      const status = scenario.status?.refPatch ?? 200;
      return status === 200
        ? jsonResponse({ ref: 'refs/heads/nexus/room123' })
        : jsonResponse({ message: 'Reference does not exist' }, status);
    }
    if (method === 'POST' && url.endsWith('/git/refs')) {
      return jsonResponse({ ref: 'refs/heads/nexus/room123' });
    }
    if (method === 'GET' && url.includes('/pulls?')) return jsonResponse(scenario.openPulls ?? []);
    if (method === 'POST' && url.endsWith('/pulls')) {
      return jsonResponse({ number: 99, html_url: 'https://github.com/acme/proj/pull/99' });
    }
    throw new Error(`test: unrouted ${method} ${url}`);
  };

  return { fetch: fn as unknown as typeof fetch, calls };
}

interface GitCall {
  args: string[];
  encoding: string | undefined;
}

/**
 * A canned local repository: the commit the room was cloned at, one `ls-tree`
 * listing, and blob bytes by sha.
 *
 * The fake deliberately behaves like real git rather than answering whatever it
 * is asked, so that dropping a flag in production shows up as a failure here.
 */
function fakeGit(opts: {
  lsTree: string;
  blobs?: Record<string, Buffer>;
  /** What `rev-parse HEAD` reports — the commit the depth-1 clone sits on. */
  localHead?: string;
  /** Make a named git subcommand fail, so the error path can be exercised. */
  failOn?: { subcommand: string; stderr: string };
}) {
  const calls: GitCall[] = [];
  const git = async (
    args: string[],
    options?: { encoding?: 'buffer' },
  ): Promise<{ stdout: string | Buffer }> => {
    calls.push({ args, encoding: options?.encoding });

    if (opts.failOn !== undefined && args.includes(opts.failOn.subcommand)) {
      // The shape promisify(execFile) actually rejects with: the full argv is
      // on BOTH `message` and `cmd`, which is the documented leak vector.
      const error = Object.assign(new Error(`Command failed: git ${args.join(' ')}`), {
        cmd: `git ${args.join(' ')}`,
        stderr: opts.failOn.stderr,
      });
      throw error;
    }

    if (args.includes('rev-parse')) return { stdout: `${opts.localHead ?? 'headcommit'}\n` };
    if (args.includes('write-tree')) return { stdout: 'localtreesha\n' };
    if (args.includes('ls-tree')) {
      // Real `ls-tree -z` emits NUL-terminated records and never C-quotes a
      // path. Fixtures are authored line-wise for readability and converted
      // here — so a production change back to newline parsing fails, and so
      // does dropping `-z` (which would silently reintroduce quoted paths).
      if (!args.includes('-z')) throw new Error('test: ls-tree must be invoked with -z');
      return { stdout: opts.lsTree.replace(/\n/g, '\0') };
    }
    if (args.includes('cat-file')) {
      const sha = args[args.length - 1] ?? '';
      const content = opts.blobs?.[sha];
      if (content === undefined) throw new Error(`test: no canned blob for ${sha}`);
      // Honour the requested encoding the way execFile does. If production ever
      // drops `{encoding:'buffer'}` it receives a utf8 STRING here and a binary
      // round trip through it corrupts the bytes — which is the behaviour the
      // binary test should catch, rather than merely recording that the option
      // was passed.
      return { stdout: options?.encoding === 'buffer' ? content : content.toString('utf8') };
    }
    if (args.includes('add')) return { stdout: '' };
    throw new Error(`test: unexpected git call: ${args.join(' ')}`);
  };
  return { git, calls };
}

function publish(
  gh: ReturnType<typeof fakeGithub>,
  git: ReturnType<typeof fakeGit>,
  lastPublishedSha: string | null = null,
) {
  return publishToGithub(
    {
      binding: BINDING,
      cwd: CWD,
      roomId: ROOM_ID,
      title: 'Work from the room',
      body: 'Produced collaboratively in SynCode.',
      lastPublishedSha,
    },
    { fetch: gh.fetch, git: git.git },
  );
}

const blobPosts = (gh: ReturnType<typeof fakeGithub>): Recorded[] =>
  gh.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/git/blobs'));
const treePost = (gh: ReturnType<typeof fakeGithub>): Recorded | undefined =>
  gh.calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/trees'));
const treeEntries = (gh: ReturnType<typeof fakeGithub>): Record<string, unknown>[] =>
  (treePost(gh)?.body?.['tree'] ?? []) as Record<string, unknown>[];
const catFileShas = (git: ReturnType<typeof fakeGit>): string[] =>
  git.calls.filter((c) => c.args.includes('cat-file')).map((c) => c.args[c.args.length - 1] ?? '');

beforeEach(() => {
  __setGithubAppConfig({ clientId: 'Iv1.testclientid', clientSecret: 's3cr3t', privateKeyPem: PEM });
});
afterEach(() => __setGithubAppConfig(null));

describe('publishToGithub — diffing against the base tree', () => {
  it('does not re-upload a path whose content is unchanged', async () => {
    const gh = fakeGithub({
      commitTrees: { headcommit: 'basetree' },
      baseTree: [
        { path: 'a.txt', mode: '100644', type: 'blob', sha: 'aaa' },
        { path: 'b.txt', mode: '100644', type: 'blob', sha: 'bbb' },
      ],
    });
    const git = fakeGit({
      lsTree: '100644 blob aaa\ta.txt\n100644 blob ccc\tb.txt\n',
      blobs: { ccc: Buffer.from('the new b') },
    });

    const result = await publish(gh, git);

    // The whole point: an unchanged file costs neither a cat-file nor an upload.
    expect(blobPosts(gh)).toHaveLength(1);
    expect(catFileShas(git)).toEqual(['ccc']);
    expect(treePost(gh)?.body?.['base_tree']).toBe('basetree');
    expect(treeEntries(gh)).toEqual([
      { path: 'b.txt', mode: '100644', type: 'blob', sha: 'uploaded1' },
    ]);
    expect(result.filesChanged).toBe(1);
    expect(result.branch).toBe('nexus/room123');
    expect(result.commitSha).toBe('newcommit');
  });

  it('sends sha:null for a path that no longer exists locally', async () => {
    const gh = fakeGithub({
      commitTrees: { headcommit: 'basetree' },
      baseTree: [
        { path: 'a.txt', mode: '100644', type: 'blob', sha: 'aaa' },
        { path: 'gone.txt', mode: '100644', type: 'blob', sha: 'ddd' },
      ],
    });
    const git = fakeGit({ lsTree: '100644 blob aaa\ta.txt\n' });

    const result = await publish(gh, git);

    expect(blobPosts(gh)).toHaveLength(0);
    expect(treeEntries(gh)).toEqual([
      { path: 'gone.txt', mode: '100644', type: 'blob', sha: null },
    ]);
    expect(result.filesChanged).toBe(1);
  });

  /**
   * A directory appears in a recursive base tree as `type: 'tree'`, but
   * `ls-tree -r` never lists directories. Treating those base entries like
   * files makes every surviving directory look deleted — and `sha: null` on a
   * tree path deletes everything beneath it.
   */
  it('ignores directory entries in the base tree instead of deleting them', async () => {
    const gh = fakeGithub({
      commitTrees: { headcommit: 'basetree' },
      baseTree: [
        { path: 'src', mode: '040000', type: 'tree', sha: 'treesha' },
        { path: 'src/a.txt', mode: '100644', type: 'blob', sha: 'aaa' },
      ],
    });
    const git = fakeGit({
      lsTree: '100644 blob aaa\tsrc/a.txt\n100644 blob eee\tsrc/new.txt\n',
      blobs: { eee: Buffer.from('brand new') },
    });

    await publish(gh, git);

    expect(treeEntries(gh)).toEqual([
      { path: 'src/new.txt', mode: '100644', type: 'blob', sha: 'uploaded1' },
    ]);
  });

  /**
   * chmod +x changes the mode but not the blob sha. The content is already in
   * the repository, so the entry must be sent — referencing the existing sha
   * rather than re-uploading it.
   */
  it('carries a mode-only change without re-uploading the content', async () => {
    const gh = fakeGithub({
      commitTrees: { headcommit: 'basetree' },
      baseTree: [{ path: 'run.sh', mode: '100644', type: 'blob', sha: 'aaa' }],
    });
    const git = fakeGit({ lsTree: '100755 blob aaa\trun.sh\n' });

    await publish(gh, git);

    expect(blobPosts(gh)).toHaveLength(0);
    expect(treeEntries(gh)).toEqual([
      { path: 'run.sh', mode: '100755', type: 'blob', sha: 'aaa' },
    ]);
  });

  it('refuses to publish anything when the base tree came back truncated', async () => {
    const gh = fakeGithub({
      commitTrees: { headcommit: 'basetree' },
      truncated: true,
      baseTree: [{ path: 'a.txt', mode: '100644', type: 'blob', sha: 'aaa' }],
    });
    const git = fakeGit({ lsTree: '100644 blob aaa\ta.txt\n' });

    await expect(publish(gh, git)).rejects.toThrow(/truncated|too large/i);

    // "Publish nothing" means nothing — not even a blob upload.
    expect(blobPosts(gh)).toHaveLength(0);
    expect(treePost(gh)).toBeUndefined();
    expect(gh.calls.some((c) => c.method === 'POST' && c.url.endsWith('/git/commits'))).toBe(false);
  });

  it('reports plainly when the working tree matches what was already published', async () => {
    const gh = fakeGithub({
      commitTrees: { headcommit: 'basetree' },
      baseTree: [{ path: 'a.txt', mode: '100644', type: 'blob', sha: 'aaa' }],
    });
    const git = fakeGit({ lsTree: '100644 blob aaa\ta.txt\n' });

    await expect(publish(gh, git)).rejects.toThrow(/nothing to publish/i);
    expect(treePost(gh)).toBeUndefined();
  });
});

describe('publishToGithub — content fidelity', () => {
  /**
   * The bytes 0x00 0xFF are not valid UTF-8. A `cat-file` read that decodes to
   * a string and re-encodes turns 0xFF into U+FFFD (ef bf bd), silently
   * corrupting every PNG the room produced. This test fails loudly if the
   * buffer path is ever dropped.
   */
  it('round-trips binary content byte for byte', async () => {
    const bytes = Buffer.from([0x00, 0xff]);
    const gh = fakeGithub({ commitTrees: { headcommit: 'basetree' }, baseTree: [] });
    const git = fakeGit({ lsTree: '100644 blob ppp\timg.png\n', blobs: { ppp: bytes } });

    await publish(gh, git);

    const upload = blobPosts(gh)[0];
    expect(upload?.body?.['encoding']).toBe('base64');
    const decoded = Buffer.from(String(upload?.body?.['content']), 'base64');
    expect([...decoded]).toEqual([0x00, 0xff]);

    // The read itself must have asked for a Buffer, not a string.
    const catFile = git.calls.find((c) => c.args.includes('cat-file'));
    expect(catFile?.encoding).toBe('buffer');
  });

  /**
   * `git cat-file blob` THROWS on a gitlink. A submodule entry has to be passed
   * through by sha, never read.
   */
  it('passes a gitlink through by sha and never cat-files it', async () => {
    const gh = fakeGithub({
      commitTrees: { headcommit: 'basetree' },
      baseTree: [{ path: 'a.txt', mode: '100644', type: 'blob', sha: 'aaa' }],
    });
    const git = fakeGit({
      lsTree: '100644 blob aaa\ta.txt\n160000 commit sub123\tvendor/lib\n',
    });

    await publish(gh, git);

    expect(catFileShas(git)).toEqual([]);
    expect(blobPosts(gh)).toHaveLength(0);
    expect(treeEntries(gh)).toEqual([
      { path: 'vendor/lib', mode: '160000', type: 'commit', sha: 'sub123' },
    ]);
  });

  it('passes core.autocrlf=false to every git invocation', async () => {
    const gh = fakeGithub({ commitTrees: { headcommit: 'basetree' }, baseTree: [] });
    const git = fakeGit({
      lsTree: '100644 blob ccc\ta.txt\n',
      blobs: { ccc: Buffer.from('hi') },
    });

    await publish(gh, git);

    expect(git.calls.length).toBeGreaterThan(0);
    for (const call of git.calls) {
      expect(call.args).toContain('core.autocrlf=false');
      expect(call.args.slice(0, 2)).toEqual(['-C', CWD]);
    }
  });
});

describe('publishToGithub — branch and pull request', () => {
  /**
   * The load-bearing parent choice. `main` moves; the room's own last published
   * commit does not. Parenting on a moved `main` makes the second publish a
   * non-fast-forward.
   */
  it('parents the commit on lastPublishedSha rather than the branch head', async () => {
    const gh = fakeGithub({
      commitTrees: { lastcommit: 'lasttree' },
      baseTree: [{ path: 'a.txt', mode: '100644', type: 'blob', sha: 'aaa' }],
    });
    const git = fakeGit({
      lsTree: '100644 blob zzz\ta.txt\n',
      blobs: { zzz: Buffer.from('changed') },
    });

    await publish(gh, git, 'lastcommit');

    expect(gh.calls.some((c) => c.url.includes('/git/ref/heads/'))).toBe(false);
    const commitPost = gh.calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/commits'));
    expect(commitPost?.body?.['parents']).toEqual(['lastcommit']);
    expect(commitPost?.body?.['tree']).toBe('newtree');
    expect(treePost(gh)?.body?.['base_tree']).toBe('lasttree');
  });

  /**
   * The room's working tree is a `--depth 1` clone taken when the room was
   * created. Basing a first publish on today's `main` instead of the commit
   * that clone actually sits on means every file a teammate pushed in between
   * is absent locally — and absent means deleted. The pull request would
   * silently propose removing their work, and report success.
   *
   * So: the parent is the CLONE's HEAD, and `main` is not even consulted.
   */
  it('bases a first publish on the clone HEAD, not on a moved default branch', async () => {
    const gh = fakeGithub({
      // `main` has moved on since this room was created.
      headSha: 'main-moved-on',
      commitTrees: { 'clone-head': 'basetree', 'main-moved-on': 'newer-tree' },
      baseTree: [],
    });
    const git = fakeGit({
      localHead: 'clone-head',
      lsTree: '100644 blob ccc\ta.txt\n',
      blobs: { ccc: Buffer.from('hi') },
    });

    await publish(gh, git, null);

    const commitPost = gh.calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/commits'));
    expect(commitPost?.body?.['parents']).toEqual(['clone-head']);
    // The base tree came from the clone's commit, so nothing on the newer main
    // can be mistaken for a deletion.
    expect(treePost(gh)?.body?.['base_tree']).toBe('basetree');
    // And the moving branch was never read at all on this path.
    expect(gh.calls.some((c) => c.url.includes('/git/ref/heads/'))).toBe(false);
  });

  it('prefers the room own last published commit over the clone HEAD', async () => {
    const gh = fakeGithub({
      commitTrees: { 'published-earlier': 'basetree' },
      baseTree: [],
    });
    const git = fakeGit({
      localHead: 'clone-head',
      lsTree: '100644 blob ccc\ta.txt\n',
      blobs: { ccc: Buffer.from('hi') },
    });

    await publish(gh, git, 'published-earlier');

    const commitPost = gh.calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/commits'));
    expect(commitPost?.body?.['parents']).toEqual(['published-earlier']);
  });

  /**
   * `lastPublishedSha` is derived from the append-only log and can never be
   * revised, so if that commit is force-pushed away the room would otherwise be
   * permanently unpublishable with no recovery short of making a new room.
   */
  it('falls back to the branch head when the base commit has been garbage collected', async () => {
    const gh = fakeGithub({
      headSha: 'headcommit',
      missingCommits: ['vanished'],
      commitTrees: { headcommit: 'basetree' },
      baseTree: [],
    });
    const git = fakeGit({
      localHead: 'clone-head',
      lsTree: '100644 blob ccc\ta.txt\n',
      blobs: { ccc: Buffer.from('hi') },
    });

    const result = await publish(gh, git, 'vanished');

    expect(result.prNumber).toBe(99);
    const refGet = gh.calls.find((c) => c.method === 'GET' && c.url.includes('/git/ref/heads/'));
    expect(refGet?.url).toContain('/repos/acme/proj/git/ref/heads/main');
    const commitPost = gh.calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/commits'));
    expect(commitPost?.body?.['parents']).toEqual(['headcommit']);
  });

  /**
   * `add -A` is the step that makes the publish reflect the working tree at
   * all. Without it `write-tree` snapshots a stale index, so a room that edited
   * files through the agent publishes an empty diff — a total feature failure
   * behind a fully green suite.
   */
  it('stages the working tree before snapshotting it', async () => {
    const gh = fakeGithub({ commitTrees: { headcommit: 'basetree' }, baseTree: [] });
    const git = fakeGit({
      lsTree: '100644 blob ccc\ta.txt\n',
      blobs: { ccc: Buffer.from('hi') },
    });

    await publish(gh, git);

    const addIndex = git.calls.findIndex((c) => c.args.includes('add') && c.args.includes('-A'));
    const writeIndex = git.calls.findIndex((c) => c.args.includes('write-tree'));
    expect(addIndex).toBeGreaterThanOrEqual(0);
    // Order matters as much as presence: staging after the snapshot is useless.
    expect(addIndex).toBeLessThan(writeIndex);
  });

  /**
   * The PATCH sha is the single value that makes the pull request contain the
   * room's work. A wrong one produces a green suite and a PR with no diff.
   */
  it('points the branch at the new commit, forcing past a rebased base', async () => {
    const gh = fakeGithub({ commitTrees: { headcommit: 'basetree' }, baseTree: [] });
    const git = fakeGit({
      lsTree: '100644 blob ccc\ta.txt\n',
      blobs: { ccc: Buffer.from('hi') },
    });

    const result = await publish(gh, git);

    const patch = gh.calls.find((c) => c.method === 'PATCH' && c.url.includes('/git/refs/heads/'));
    expect(patch?.url).toContain('/git/refs/heads/nexus/room123');
    expect(patch?.body?.['sha']).toBe('newcommit');
    expect(patch?.body?.['sha']).toBe(result.commitSha);
    // The branch belongs to this room alone; after the base commit is rebased
    // the update is rejected without this.
    expect(patch?.body?.['force']).toBe(true);
  });

  it('creates the branch when moving it reports the ref does not exist', async () => {
    const gh = fakeGithub({
      commitTrees: { headcommit: 'basetree' },
      baseTree: [],
      status: { refPatch: 404 },
    });
    const git = fakeGit({
      lsTree: '100644 blob ccc\ta.txt\n',
      blobs: { ccc: Buffer.from('hi') },
    });

    await publish(gh, git);

    const refPost = gh.calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/refs'));
    expect(refPost?.body).toEqual({ ref: 'refs/heads/nexus/room123', sha: 'newcommit' });
  });

  it('opens a pull request when the room has none open', async () => {
    const gh = fakeGithub({ commitTrees: { headcommit: 'basetree' }, baseTree: [] });
    const git = fakeGit({
      lsTree: '100644 blob ccc\ta.txt\n',
      blobs: { ccc: Buffer.from('hi') },
    });

    const result = await publish(gh, git);

    const pullsGet = gh.calls.find((c) => c.method === 'GET' && c.url.includes('/pulls?'));
    expect(pullsGet?.url).toContain('state=open');
    expect(decodeURIComponent(pullsGet?.url ?? '')).toContain('head=acme:nexus/room123');
    const pullsPost = gh.calls.find((c) => c.method === 'POST' && c.url.endsWith('/pulls'));
    expect(pullsPost?.body).toMatchObject({ head: 'nexus/room123', base: 'main' });
    expect(result).toMatchObject({
      created: true,
      prNumber: 99,
      prUrl: 'https://github.com/acme/proj/pull/99',
    });
  });

  /**
   * The reason the branch name is stable per room: a second publish must update
   * the same pull request instead of opening a second one.
   */
  it('updates the existing pull request instead of opening another', async () => {
    const gh = fakeGithub({
      commitTrees: { lastcommit: 'lasttree' },
      baseTree: [],
      openPulls: [{ number: 12, html_url: 'https://github.com/acme/proj/pull/12' }],
    });
    const git = fakeGit({
      lsTree: '100644 blob ccc\ta.txt\n',
      blobs: { ccc: Buffer.from('hi') },
    });

    const result = await publish(gh, git, 'lastcommit');

    expect(result.created).toBe(false);
    expect(result.prNumber).toBe(12);
    expect(result.prUrl).toBe('https://github.com/acme/proj/pull/12');
    expect(gh.calls.some((c) => c.method === 'POST' && c.url.endsWith('/pulls'))).toBe(false);
  });
});

describe('publishToGithub — credential handling (I4)', () => {
  /**
   * `runGit`'s catch block is the one function in this module written
   * specifically to defend I4 on the subprocess path: `promisify(execFile)`
   * puts the full argv on BOTH `error.message` and `error.cmd`, so the handler
   * reads `stderr` alone. Nothing exercised it, which made it the only I4 guard
   * here with no coverage — so the documented leak could be reintroduced with a
   * green suite.
   */
  it('builds a local git failure from stderr alone, never from message or cmd', async () => {
    const gh = fakeGithub({ commitTrees: { headcommit: 'basetree' }, baseTree: [] });
    const git = fakeGit({
      lsTree: '100644 blob ccc\ta.txt\n',
      // The argv this fake puts on `.message`/`.cmd` carries a credential-shaped
      // string; only `.stderr` is safe to surface.
      failOn: {
        subcommand: 'write-tree',
        stderr: 'fatal: not a git repository\n',
      },
    });

    const failure = await publish(gh, git).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain('not a git repository');
    // The tell that the handler used stderr: argv words never appear.
    expect(message).not.toContain('Command failed');
    expect(message).not.toContain('write-tree');
    expect(message).not.toContain('core.autocrlf');
  });

  it('redacts a credential that git itself printed to stderr', async () => {
    const gh = fakeGithub({ commitTrees: { headcommit: 'basetree' }, baseTree: [] });
    const git = fakeGit({
      lsTree: '100644 blob ccc\ta.txt\n',
      failOn: {
        subcommand: 'write-tree',
        stderr: 'fatal: could not read https://x-access-token:ghs_leakedfromstderr@github.com/a/b\n',
      },
    });

    const failure = await publish(gh, git).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(String(failure)).not.toContain('ghs_leakedfromstderr');
  });

  it('authorizes every API call with the minted token', async () => {
    const gh = fakeGithub({ commitTrees: { headcommit: 'basetree' }, baseTree: [] });
    const git = fakeGit({
      lsTree: '100644 blob ccc\ta.txt\n',
      blobs: { ccc: Buffer.from('hi') },
    });

    await publish(gh, git);

    // The first call is the mint itself, authorized with the App JWT.
    const afterMint = gh.calls.slice(1);
    expect(afterMint.length).toBeGreaterThan(4);
    for (const call of afterMint) {
      expect(call.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('never puts the token into a subprocess argument list', async () => {
    const gh = fakeGithub({ commitTrees: { headcommit: 'basetree' }, baseTree: [] });
    const git = fakeGit({
      lsTree: '100644 blob ccc\ta.txt\n',
      blobs: { ccc: Buffer.from('hi') },
    });

    await publish(gh, git);

    for (const call of git.calls) {
      expect(call.args.join(' ')).not.toContain(TOKEN);
      expect(call.args.join(' ')).not.toContain('ghs_');
    }
  });

  /**
   * Errors from this function reach `agent_error`, which is logged AND
   * broadcast to every browser in the room.
   */
  it('never leaks the token through a rejected API call', async () => {
    const gh = fakeGithub({
      commitTrees: { headcommit: 'basetree' },
      baseTree: [],
      status: { trees: 422 },
    });
    const git = fakeGit({
      lsTree: '100644 blob ccc\ta.txt\n',
      blobs: { ccc: Buffer.from('hi') },
    });

    const error = await publish(gh, git).then(
      () => new Error('test: publish should have rejected'),
      (caught: unknown) => caught as Error,
    );

    expect(error.message).toMatch(/422/);
    for (const text of [error.message, String(error.stack)]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('ghs_');
    }
  });
});
