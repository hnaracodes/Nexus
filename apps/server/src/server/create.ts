import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { mintCloneToken } from './github.js';
import type { GithubBinding, GithubDeps } from './github.js';

/**
 * The one child-process shape this module spawns, named narrowly on purpose.
 *
 * `promisify(execFile)` carries node's full overload set (buffer encodings,
 * shell options, …). Nothing can be assigned to an overloaded type without a
 * cast, so a test wanting to inject a recording runner would have to launder it
 * through `as unknown as` — which defeats the point of a typed seam. Declaring
 * the single signature we actually call keeps `CloneDeps.run` checkable.
 */
export type RunExecFile = (
  file: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

const runExecFile: RunExecFile = promisify(execFile);
const DEFAULT_WORKDIR = process.env['NEXUS_WORKDIR'] ?? './work';
const CLONE_TIMEOUT_MS = 120_000;
const SAFE_ROOM_ID = /^[A-Za-z0-9_-]+$/;
// Deliberately narrow: https only, no shell metacharacters, no credentials.
const SAFE_REPO_URL = /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;

// Private, loopback, link-local (includes the 169.254.169.254 cloud metadata
// address) and reserved ranges. `POST /api/rooms` drives an outbound git
// clone with no credential required to call it, so this list is what stands
// between an anonymous caller and the server's own network.
const BLOCKED_HOSTS = new BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_HOSTS.addSubnet(addr, prefix, 'ipv4');
}
BLOCKED_HOSTS.addAddress('::1', 'ipv6');
BLOCKED_HOSTS.addSubnet('fe80::', 10, 'ipv6'); // link-local
BLOCKED_HOSTS.addSubnet('fc00::', 7, 'ipv6'); // unique local
BLOCKED_HOSTS.addSubnet('::ffff:0:0', 96, 'ipv6'); // IPv4-mapped

function isBlockedAddress(address: string): boolean {
  if (isIPv4(address)) return BLOCKED_HOSTS.check(address, 'ipv4');
  if (isIPv6(address)) return BLOCKED_HOSTS.check(address, 'ipv6');
  return false;
}

/**
 * Resolved at clone time, not just at request-validation time. A hostname
 * that resolves to a public address when checked and a private one moments
 * later (DNS rebinding) can still slip through the gap between this check
 * and the `git clone` that follows — closing that gap fully would mean
 * pinning the resolved address into the clone itself, which is more than
 * this pass attempts. Re-checking here instead of only at submission time at
 * least removes the much larger, trivially-exploitable window where a
 * validated URL sits unclonned for an arbitrary amount of time.
 */
async function assertRepoHostIsSafe(repoUrl: string): Promise<void> {
  const { hostname } = new URL(repoUrl);
  if (hostname.toLowerCase() === 'localhost') {
    throw new Error('blocked host');
  }
  if (isIPv4(hostname) || isIPv6(hostname)) {
    if (isBlockedAddress(hostname)) throw new Error('blocked host');
    return;
  }
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  for (const record of records) {
    if (isBlockedAddress(record.address)) throw new Error('blocked host');
  }
}

// Carries the validated key forward, the way validateRepoUrl carries `.url`.
// Returning a bare { ok: true } forces the caller to reach back for the raw
// body value, which is typed `string | undefined` and will not compile against
// CreateRoomOptions.apiKey.
export function validateApiKeyShape(
  value: unknown,
): { ok: true; apiKey: string } | { ok: false; message: string } {
  if (typeof value !== 'string' || !value.startsWith('sk-ant-')) {
    // Never echo the received value — it may be a real credential.
    return {
      ok: false,
      message:
        'Nexus needs an Anthropic Console API key beginning with "sk-ant-". Subscription logins (Free, Pro, Max) cannot be used by third-party tools.',
    };
  }
  return { ok: true, apiKey: value };
}

export function validateRepoUrl(
  value: unknown,
): { ok: true; url: string | null } | { ok: false; message: string } {
  if (value === undefined || value === null || value === '') return { ok: true, url: null };
  if (typeof value !== 'string' || !SAFE_REPO_URL.test(value)) {
    return { ok: false, message: 'Repository URL must be a plain https:// address.' };
  }

  // The charset above permits ':' and '@', so "https://user:token@host/x.git"
  // sails through — and repoUrl is committed unredacted into room_created,
  // broadcast to every socket, and written to the meta sidecar whose whole
  // point is holding nothing secret. Redaction only ever matched sk-ant-…, so
  // a git PAT would land in the durable log in clear text.
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, message: 'Repository URL must be a plain https:// address.' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return {
      ok: false,
      // Never echo the URL back — it is the thing carrying the credential.
      message:
        'Remove the credentials from the repository URL. Nexus logs the URL, and the log is meant to be shareable.',
    };
  }

  // Cheap synchronous rejection for the obvious cases (a literal blocked IP,
  // or "localhost") so they 400 immediately without a DNS round trip. This is
  // a fast path, not the real defense — assertRepoHostIsSafe below re-checks
  // at clone time, which is what actually matters against DNS rebinding.
  if (
    parsed.hostname.toLowerCase() === 'localhost' ||
    ((isIPv4(parsed.hostname) || isIPv6(parsed.hostname)) && isBlockedAddress(parsed.hostname))
  ) {
    return { ok: false, message: 'That repository host is not reachable from this server.' };
  }

  return { ok: true, url: value };
}

// --- Private cloning through the GitHub App ---------------------------------

/** Injection seam: both the token mint and the child process are stubbable. */
export interface CloneDeps {
  fetch?: typeof fetch;
  run?: RunExecFile;
}

/**
 * GitHub's own charset for a login and a repository name. The binding always
 * comes from `findVerifiedRepo`, i.e. from a list this server fetched from
 * GitHub — but the URL below is built by concatenation, and a name containing
 * `@` or `/` would silently retarget the clone at another host. Cheap enough
 * to check that there is no reason to rely on the caller.
 */
const SAFE_GITHUB_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * The credential helper. Its SCRIPT TEXT lives in argv; the token it echoes
 * lives in the child's environment and never appears on a command line.
 *
 * This is the whole point of the design. `promisify(execFile)` rejects with
 * `Error.message = "Command failed: <file> <args joined>"` (and the same string
 * on `.cmd`), and that message reaches `agent_error`, which is appended to the
 * durable log AND broadcast to every browser in the room. A token in argv is
 * therefore a token in the shared, exportable transcript — I4. A token in the
 * child env is not: it is absent from `.message`, `.cmd` and `.stderr`.
 */
const CREDENTIAL_HELPER =
  '!f() { echo username=x-access-token; echo "password=$NEXUS_GH_TOKEN"; }; f';

function cleanCloneUrl(binding: GithubBinding): string {
  if (!SAFE_GITHUB_NAME.test(binding.owner) || !SAFE_GITHUB_NAME.test(binding.repo)) {
    throw new Error('unsafe github repository name');
  }
  return `https://github.com/${binding.owner}/${binding.repo}.git`;
}

/**
 * Clone a (possibly private) repository using a freshly minted, read-only,
 * single-repository installation token.
 *
 * Two details are load-bearing:
 *
 *  - The empty `-c credential.helper=` comes FIRST. Git accumulates helpers and
 *    asks each in order; an empty value resets the list, so an inherited
 *    system/global helper (Git Credential Manager on Windows, osxkeychain) can
 *    neither answer ahead of ours nor be handed our token to store.
 *  - `--` before the URL. The URL is server-built, but a leading `-` in any
 *    position must never be able to become a git option.
 *
 * The failure path deliberately re-throws the underlying message rather than
 * substituting the token out of it. The guarantee here is "the credential is
 * never in argv", and it has to stay load-bearing: a `replaceAll(token, '***')`
 * backstop would hide a regression in that guarantee from the test written to
 * catch it, while only ever matching the one exact spelling of the token.
 */
export async function cloneViaGithubApp(
  binding: GithubBinding,
  cwd: string,
  deps?: CloneDeps,
): Promise<void> {
  const url = cleanCloneUrl(binding);
  const spawn = deps?.run ?? runExecFile;
  // exactOptionalPropertyTypes: `{ fetch: undefined }` is not the same as an
  // absent property, so build the deps object rather than passing undefined in.
  const githubDeps: GithubDeps | undefined =
    deps?.fetch === undefined ? undefined : { fetch: deps.fetch };

  const token = await mintCloneToken(binding, githubDeps);

  try {
    await spawn(
      'git',
      [
        '-c',
        'credential.helper=',
        '-c',
        `credential.helper=${CREDENTIAL_HELPER}`,
        'clone',
        '--depth',
        '1',
        '--',
        url,
        cwd,
      ],
      {
        env: { ...process.env, NEXUS_GH_TOKEN: token },
        timeout: CLONE_TIMEOUT_MS,
      },
    );
  } catch (error) {
    // Safe to include: with the token out of argv, the execFile message carries
    // only the command line and git's own stderr, and git never echoes a
    // password supplied by a helper. Naming the repo makes the log useful.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git clone of ${binding.owner}/${binding.repo} failed: ${detail}`);
  }

  // Belt and braces. The clone url above is already credential-free, so this
  // rewrites `origin` to the value it should already hold — it exists so that
  // any future change to how the clone is invoked cannot leave something
  // credential-shaped sitting in .git/config, which the agent can read.
  await spawn('git', ['-C', cwd, 'remote', 'set-url', 'origin', url], {
    timeout: CLONE_TIMEOUT_MS,
  });
}

/** One working directory per room. Never the server's own checkout. */
export async function prepareWorkspace(
  roomId: string,
  repoUrl: string | null,
  baseDir: string = DEFAULT_WORKDIR,
  github?: GithubBinding | null,
  // Forwarded to cloneViaGithubApp. Without this seam the GitHub branch below
  // is untestable, and deleting it would silently downgrade every private-repo
  // room to an unauthenticated public clone with the whole suite still green.
  deps?: CloneDeps,
): Promise<string> {
  if (!SAFE_ROOM_ID.test(roomId)) {
    throw new Error(`unsafe room id: ${JSON.stringify(roomId)}`);
  }
  const cwd = join(resolve(baseDir), roomId);
  mkdirSync(cwd, { recursive: true });

  // A binding wins over any repoUrl: the binding is the verified thing (it came
  // out of a list GitHub gave this server for this user), whereas repoUrl is
  // whatever the browser typed. Cloning both into one directory would fail
  // anyway, and cloning the typed one would be the wrong repository.
  if (github !== undefined && github !== null) {
    // No assertRepoHostIsSafe here, deliberately: that guard exists because the
    // anonymous path clones a host an unauthenticated caller supplied. Here the
    // host is the literal string "github.com", built by cleanCloneUrl — there is
    // no attacker-controlled hostname to resolve, and a DNS lookup of github.com
    // would only add a network dependency to every room creation.
    await cloneViaGithubApp(github, cwd, deps);
    return cwd;
  }

  if (repoUrl !== null) {
    await assertRepoHostIsSafe(repoUrl);
    // execFile with an argument array — never a shell string.
    await runExecFile('git', ['clone', '--depth', '1', repoUrl, cwd], {
      timeout: CLONE_TIMEOUT_MS,
    });
  }

  return cwd;
}
