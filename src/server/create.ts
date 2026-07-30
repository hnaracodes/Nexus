import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DEFAULT_WORKDIR = process.env['NEXUS_WORKDIR'] ?? './work';
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

/** One working directory per room. Never the server's own checkout. */
export async function prepareWorkspace(
  roomId: string,
  repoUrl: string | null,
  baseDir: string = DEFAULT_WORKDIR,
): Promise<string> {
  if (!SAFE_ROOM_ID.test(roomId)) {
    throw new Error(`unsafe room id: ${JSON.stringify(roomId)}`);
  }
  const cwd = join(resolve(baseDir), roomId);
  mkdirSync(cwd, { recursive: true });

  if (repoUrl !== null) {
    await assertRepoHostIsSafe(repoUrl);
    // execFile with an argument array — never a shell string.
    await run('git', ['clone', '--depth', '1', repoUrl, cwd], { timeout: 120_000 });
  }

  return cwd;
}
