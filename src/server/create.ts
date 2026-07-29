import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DEFAULT_WORKDIR = process.env['NEXUS_WORKDIR'] ?? './work';
const SAFE_ROOM_ID = /^[A-Za-z0-9_-]+$/;
// Deliberately narrow: https only, no shell metacharacters, no credentials.
const SAFE_REPO_URL = /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;

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
    // execFile with an argument array — never a shell string.
    await run('git', ['clone', '--depth', '1', repoUrl, cwd], { timeout: 120_000 });
  }

  return cwd;
}
