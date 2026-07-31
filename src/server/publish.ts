/**
 * Publish a room's work as a pull request (plan phase-6.3).
 *
 * The room's working directory is an ordinary clone that many people have been
 * editing through one agent. This module turns whatever is on disk right now
 * into a commit on a room-stable branch and a pull request against the default
 * branch — using the GitHub Git Data API, never `git push`.
 *
 * That choice is the load-bearing one, and it is about I4, not convenience:
 *
 *   A credential in git's ARGV leaks. `promisify(execFile)` rejects with
 *   `Error.message = "Command failed: <file> <args joined>"` and puts the same
 *   string on `.cmd`, so a `git push https://x-access-token:ghs_…@github.com/…`
 *   that fails writes the token straight into `agent_error` — which is LOGGED
 *   and BROADCAST to every browser in the room. Passing it in the child's env
 *   would be safe, but there is no need to hand it to a subprocess at all: the
 *   API needs it only in a `fetch` Authorization header, and `git` here is used
 *   purely locally (`add`, `write-tree`, `ls-tree`, `cat-file`) with no remote
 *   and no credential anywhere near it.
 *
 * Both seams — the network and the local git invocation — are injectable so
 * every test runs with no network and no real repository.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redactString } from '../log/redact.js';
import { mintPublishToken, type GithubBinding } from './github.js';

const GITHUB_API = 'https://api.github.com';

/** Branch names are `nexus/<roomId>`; room ids are already this narrow. */
const SAFE_ROOM_ID = /^[A-Za-z0-9_-]+$/;

/** Gitlink (submodule). `git cat-file blob` throws on one — pass it by sha. */
const GITLINK_MODE = '160000';

/**
 * `execFile` buffers a child's whole stdout in memory and rejects past this.
 * The default is 1 MB, which would fail on any file bigger than that — a
 * confusing "Local git failed" on a perfectly ordinary 2 MB image.
 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface PublishResult {
  prUrl: string;
  prNumber: number;
  branch: string;
  commitSha: string;
  filesChanged: number;
  /** false when an existing pull request was updated instead of opened. */
  created: boolean;
}

/**
 * The local git seam. Deliberately narrow: an argument array and an optional
 * request for raw bytes. There is no `cwd` option because `-C <cwd>` is passed
 * in the arguments, which keeps the whole invocation visible to a test.
 */
export type GitRunner = (
  args: string[],
  opts?: { encoding?: 'buffer' },
) => Promise<{ stdout: string | Buffer }>;

export interface PublishDeps {
  fetch?: typeof fetch;
  git?: GitRunner;
}

export interface PublishOptions {
  binding: GithubBinding;
  cwd: string;
  roomId: string;
  title: string;
  body: string;
  /** The room's OWN last published commit sha, or null on first publish. */
  lastPublishedSha: string | null;
}

/** One entry in a `POST /git/trees` payload. `sha: null` deletes the path. */
interface TreeEntryInput {
  path: string;
  mode: string;
  type: 'blob' | 'commit';
  sha: string | null;
}

interface LocalEntry {
  mode: string;
  type: string;
  sha: string;
  path: string;
}

interface BaseEntry {
  mode: string;
  type: 'blob' | 'commit';
  sha: string;
}

// --- HTTP -------------------------------------------------------------------

interface ApiResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

/**
 * Every GitHub call goes through here, for the same reason `github.ts` funnels
 * its own: no call site can then interpolate a credential, a credential-bearing
 * URL, or a raw response body into a thrown message. Status code and a plain
 * description of the attempted operation, nothing else.
 *
 * `allow` lists non-2xx statuses the caller wants to handle itself rather than
 * treat as fatal — used for "does this branch ref already exist?".
 */
async function callGithub(
  doFetch: typeof fetch,
  token: string,
  method: string,
  url: string,
  body: unknown | undefined,
  what: string,
  allow: number[] = [],
): Promise<ApiResponse> {
  const response = await doFetch(url, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'nexus',
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    if (!allow.includes(response.status)) {
      throw new Error(`GitHub rejected the request to ${what} (HTTP ${response.status}).`);
    }
    // Body deliberately not read: an error body is exactly the thing we must
    // not echo, and no allow-listed caller needs it.
    return { status: response.status, ok: false, body: undefined };
  }

  return { status: response.status, ok: true, body: (await response.json()) as unknown };
}

/** Pull `.sha` off a response, refusing to continue on a shape we don't know. */
function readSha(value: unknown, what: string): string {
  const sha = (value as { sha?: unknown } | null | undefined)?.sha;
  if (typeof sha !== 'string' || sha === '') {
    throw new Error(`GitHub returned no ${what}.`);
  }
  return sha;
}

function readPullRequest(value: unknown): { prUrl: string; prNumber: number } {
  const pr = value as { number?: unknown; html_url?: unknown } | null | undefined;
  if (typeof pr?.number !== 'number' || typeof pr.html_url !== 'string') {
    throw new Error('GitHub returned a pull request in a shape Nexus does not recognise.');
  }
  return { prUrl: pr.html_url, prNumber: pr.number };
}

// --- Local git --------------------------------------------------------------

const execFileAsync = promisify(execFile);

const defaultGit: GitRunner = async (args, opts) => {
  if (opts?.encoding === 'buffer') {
    const { stdout } = await execFileAsync('git', args, {
      encoding: 'buffer',
      maxBuffer: GIT_MAX_BUFFER,
    });
    return { stdout };
  }
  const { stdout } = await execFileAsync('git', args, {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
  });
  return { stdout };
};

/**
 * Run git, and on failure raise an error built ONLY from stderr.
 *
 * `error.message` and `error.cmd` both carry the full argument list, so they
 * are never touched — today nothing secret is in git's argv here, but this
 * function is the place a future "just push it" patch would put one, and the
 * error path is broadcast. stderr is separately run through the log's own
 * redactor as a second line of defence.
 */
async function runGit(
  git: GitRunner,
  args: string[],
  what: string,
  opts?: { encoding?: 'buffer' },
): Promise<string | Buffer> {
  try {
    const { stdout } = await git(args, opts);
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const raw = Buffer.isBuffer(stderr)
      ? stderr.toString('utf8')
      : typeof stderr === 'string'
        ? stderr
        : '';
    const detail = redactString(raw)
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '');
    throw new Error(
      detail === undefined
        ? `Local git failed while ${what}.`
        : `Local git failed while ${what}: ${detail.slice(0, 200)}`,
    );
  }
}

function asText(stdout: string | Buffer): string {
  return Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout;
}

/**
 * Parse `<mode> <type> <sha>\t<path>` records from `ls-tree -r -z --full-tree`.
 *
 * `-r` without `-t` lists blobs and gitlinks only — never directories — which
 * is exactly what we want, since a directory has no independent existence to
 * diff.
 *
 * **`-z` is load-bearing, and `core.quotePath=false` is not enough on its own.**
 * That setting only stops git escaping bytes above 0x80; per git-config it still
 * C-quotes a path containing `"`, `\` or a control character, wrapping the whole
 * name in quotes. The quoted spelling would then enter the diff as if it were
 * the real path, so an untouched file called `say"hi.txt` would be published as
 * a deletion of the real path plus a new blob at the mangled one. `-z` emits
 * NUL-terminated records and never quotes. Such names are illegal on Windows
 * but perfectly legal on the Debian container this actually runs on.
 */
function parseLsTree(text: string): LocalEntry[] {
  const entries: LocalEntry[] = [];
  for (const rawLine of text.split('\0')) {
    // A stray CR would otherwise become part of the path on a Windows box.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const [mode, type, sha] = line.slice(0, tab).split(/\s+/);
    const path = line.slice(tab + 1);
    if (mode === undefined || type === undefined || sha === undefined || path === '') continue;
    entries.push({ mode, type, sha, path });
  }
  return entries;
}

// --- Publish ----------------------------------------------------------------

export async function publishToGithub(
  opts: PublishOptions,
  deps?: PublishDeps,
): Promise<PublishResult> {
  // The room id becomes a ref name and a URL path segment. Room ids are already
  // generated from this alphabet; the check is here so a future id format
  // cannot quietly turn into ref injection.
  if (!SAFE_ROOM_ID.test(opts.roomId)) {
    throw new Error('Cannot publish: this room id cannot be used as a branch name.');
  }

  const doFetch = deps?.fetch ?? fetch;
  const git = deps?.git ?? defaultGit;
  const { owner, repo, defaultBranch } = opts.binding;

  // STABLE per room. This one line is why a second publish updates the same
  // pull request instead of opening a second one.
  const branch = `nexus/${opts.roomId}`;
  const repoBase = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  // Scoped to this one repository, contents+PR write, and valid for an hour.
  const token = await mintPublishToken(opts.binding, { fetch: doFetch });
  const api = (
    method: string,
    url: string,
    body: unknown | undefined,
    what: string,
    allow?: number[],
  ): Promise<ApiResponse> => callGithub(doFetch, token, method, url, body, what, allow);

  // `core.autocrlf=false` on EVERY call is a blob-sha skew guard: a Windows dev
  // box and the Debian container must hash identical bytes, or every text file
  // looks changed. `core.quotePath=false` plus `-z` below keeps paths literal.
  const gitPrefix = ['-C', opts.cwd, '-c', 'core.autocrlf=false', '-c', 'core.quotePath=false'];

  // 1. The commit we build on. Three cases, and each one matters.
  //
  //  a. The room's own last published commit, when there is one. `main` moves
  //     while a room works, and parenting the second publish on a moved `main`
  //     produces a non-fast-forward when the branch ref is updated.
  //
  //  b. Otherwise the room's OWN cloned HEAD — deliberately NOT today's `main`.
  //     The working tree came from a `--depth 1` clone taken when the room was
  //     created, so anything pushed to `main` since then is simply absent from
  //     it. Diffing against today's `main` would emit every such file as a
  //     `sha: null` deletion and revert teammates' edits to their clone-time
  //     content — in a pull request that reports success. This is the same
  //     "absent means deleted" hazard the truncated-tree check below refuses
  //     to take, applied to a moving branch instead of a partial listing.
  //     Basing on the clone's own commit makes the diff mean "what this room
  //     changed", which is what a branch is supposed to mean.
  //
  //  c. If the preferred commit is unreadable — force-push plus GC, or a
  //     deleted branch — fall back to the branch head rather than throwing.
  //     Without this a room whose base commit vanished is permanently
  //     unpublishable, because `lastPublishedSha` comes from the append-only
  //     log and can never be revised.
  const localHeadSha = asText(
    await runGit(git, [...gitPrefix, 'rev-parse', 'HEAD'], 'reading the local commit'),
  ).trim();

  let baseCommitSha = opts.lastPublishedSha ?? localHeadSha;
  // A commit sha is not a tree sha, and `base_tree` needs the tree.
  let baseCommit = await api(
    'GET',
    `${repoBase}/git/commits/${baseCommitSha}`,
    undefined,
    'read the commit being built on',
    [404, 422],
  );
  if (!baseCommit.ok) {
    // Branch names are hierarchical, so the ref path keeps its literal slashes;
    // git forbids the characters that would make that ambiguous.
    const ref = await api(
      'GET',
      `${repoBase}/git/ref/heads/${defaultBranch}`,
      undefined,
      `read the ${defaultBranch} branch`,
    );
    baseCommitSha = readSha((ref.body as { object?: unknown } | undefined)?.object, 'branch head');
    baseCommit = await api(
      'GET',
      `${repoBase}/git/commits/${baseCommitSha}`,
      undefined,
      'read the commit being built on',
    );
  }
  const baseTreeSha = readSha(
    (baseCommit.body as { tree?: unknown } | undefined)?.tree,
    'tree for the base commit',
  );

  // 2. Snapshot the working tree locally.
  //
  // `add -A` still honours .gitignore, so node_modules and friends stay out.
  await runGit(git, [...gitPrefix, 'add', '-A'], 'staging the working tree');
  const localTreeSha = asText(
    await runGit(git, [...gitPrefix, 'write-tree'], 'snapshotting the working tree'),
  ).trim();
  const localEntries = parseLsTree(
    asText(
      await runGit(
        git,
        [...gitPrefix, 'ls-tree', '-r', '-z', '--full-tree', localTreeSha],
        'listing the working tree',
      ),
    ),
  );

  // 3. The remote side of the diff.
  const baseTreeResponse = await api(
    'GET',
    `${repoBase}/git/trees/${baseTreeSha}?recursive=1`,
    undefined,
    'read the repository contents',
  );
  const baseTreeBody = baseTreeResponse.body as {
    truncated?: unknown;
    tree?: { path?: unknown; mode?: unknown; type?: unknown; sha?: unknown }[];
  };

  // GitHub caps a recursive tree at 100k entries / 7 MB and sets `truncated`.
  // A partial base tree makes every unseen path look absent, and absent means
  // deleted — so a truncated response would silently delete half the repo.
  // Refuse, and write nothing.
  if (baseTreeBody.truncated === true) {
    throw new Error(
      'Cannot publish: this repository is too large for Nexus to diff safely — GitHub truncated the file listing. Nothing was published.',
    );
  }

  const base = new Map<string, BaseEntry>();
  for (const entry of baseTreeBody.tree ?? []) {
    // `type: 'tree'` entries are directories. `ls-tree -r` never lists those,
    // so treating them as files makes every surviving directory look deleted —
    // and `sha: null` on a tree path removes everything beneath it.
    if (entry.type !== 'blob' && entry.type !== 'commit') continue;
    if (
      typeof entry.path !== 'string' ||
      typeof entry.mode !== 'string' ||
      typeof entry.sha !== 'string'
    ) {
      continue;
    }
    base.set(entry.path, { mode: entry.mode, type: entry.type, sha: entry.sha });
  }

  // 4. Diff by path, uploading only what actually changed.
  const entries: TreeEntryInput[] = [];
  const localPaths = new Set<string>();

  for (const local of localEntries) {
    localPaths.add(local.path);
    const existing = base.get(local.path);

    // Identical content AND identical mode: `base_tree` already carries it.
    // Skipping here is what keeps a publish proportional to the change rather
    // than to the size of the repository.
    if (existing !== undefined && existing.sha === local.sha && existing.mode === local.mode) {
      continue;
    }

    if (local.mode === GITLINK_MODE) {
      // A submodule pointer. `git cat-file blob` THROWS on a gitlink; the sha
      // is a commit in another repository and is passed through untouched.
      entries.push({ path: local.path, mode: GITLINK_MODE, type: 'commit', sha: local.sha });
      continue;
    }

    if (existing !== undefined && existing.sha === local.sha) {
      // Mode-only change (chmod +x). The content is already a blob in this
      // repository — reference it rather than re-uploading identical bytes.
      entries.push({ path: local.path, mode: local.mode, type: 'blob', sha: local.sha });
      continue;
    }

    // `encoding: 'buffer'` is not optional. A utf8 read replaces every byte
    // that is not valid UTF-8 with U+FFFD, which corrupts every binary file in
    // the room's work — silently, since the commit still succeeds.
    const raw = await runGit(
      git,
      [...gitPrefix, 'cat-file', 'blob', local.sha],
      'reading a changed file',
      { encoding: 'buffer' },
    );
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
    const uploaded = await api(
      'POST',
      `${repoBase}/git/blobs`,
      { content: bytes.toString('base64'), encoding: 'base64' },
      'upload a file',
    );
    entries.push({
      path: local.path,
      mode: local.mode,
      type: 'blob',
      sha: readSha(uploaded.body, 'sha for an uploaded file'),
    });
  }

  for (const [path, existing] of base) {
    if (localPaths.has(path)) continue;
    // `sha: null` is how the Git Data API expresses a deletion. Mode and type
    // come from the base entry so a removed submodule is not described as a
    // blob.
    entries.push({ path, mode: existing.mode, type: existing.type, sha: null });
  }

  if (entries.length === 0) {
    // Not an internal failure — the honest answer to "publish this". Creating
    // an empty commit instead would stack a no-op commit per attempt, and
    // GitHub refuses to open a pull request with no diff anyway.
    throw new Error(
      'There is nothing to publish: the working tree matches what is already on the branch.',
    );
  }

  // 5. Tree, commit, branch.
  const newTree = await api(
    'POST',
    `${repoBase}/git/trees`,
    { base_tree: baseTreeSha, tree: entries },
    'create the tree',
  );
  const message = `${opts.title}\n\n${opts.body}`.trim();
  const newCommit = await api(
    'POST',
    `${repoBase}/git/commits`,
    { message, tree: readSha(newTree.body, 'sha for the new tree'), parents: [baseCommitSha] },
    'create the commit',
  );
  const commitSha = readSha(newCommit.body, 'sha for the new commit');

  // Move the branch if it exists, create it if it does not. `force: true` is
  // safe and necessary: the branch belongs to this room alone, and after a
  // rebase of the base commit the update would otherwise be rejected.
  //
  // GitHub answers a missing ref with 404 on some paths and 422 ("Reference
  // does not exist") on others, so both fall through to creation.
  const moved = await api(
    'PATCH',
    `${repoBase}/git/refs/heads/${branch}`,
    { sha: commitSha, force: true },
    'update the branch',
    [404, 422],
  );
  if (!moved.ok) {
    await api(
      'POST',
      `${repoBase}/git/refs`,
      { ref: `refs/heads/${branch}`, sha: commitSha },
      'create the branch',
    );
  }

  // 6. One pull request per room, reused.
  const query = new URLSearchParams({ head: `${owner}:${branch}`, state: 'open' });
  const openPulls = await api(
    'GET',
    `${repoBase}/pulls?${query.toString()}`,
    undefined,
    'look for an existing pull request',
  );
  const existing = Array.isArray(openPulls.body) ? openPulls.body[0] : undefined;
  if (existing !== undefined) {
    return {
      ...readPullRequest(existing),
      branch,
      commitSha,
      filesChanged: entries.length,
      created: false,
    };
  }

  const opened = await api(
    'POST',
    `${repoBase}/pulls`,
    { title: opts.title, body: opts.body, head: branch, base: defaultBranch },
    'open a pull request',
  );
  return {
    ...readPullRequest(opened.body),
    branch,
    commitSha,
    filesChanged: entries.length,
    created: true,
  };
}
