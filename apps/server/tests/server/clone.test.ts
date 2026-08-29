/**
 * Private repository cloning through the GitHub App (plan phase-6.2).
 *
 * The single property under test is the one that has already bitten this
 * project: **a credential must never appear in a child process's argv.**
 * `promisify(execFile)` rejects with `Error.message = "Command failed: <file>
 * <args joined>"` — and that message reaches `agent_error` / `tool_result`,
 * which are written to the append-only log AND broadcast to every browser in
 * the room. A token in argv is therefore a token in the shared transcript.
 *
 * So the token travels in the child ENVIRONMENT, read by a git credential
 * helper whose SCRIPT TEXT is in argv while its VALUE never is. These tests
 * pin both halves of that: the token is absent from argv on success and on
 * failure, and present in the env (so the argv assertions cannot pass
 * vacuously because no credential was supplied at all).
 */

import { existsSync, mkdtempSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cloneViaGithubApp, prepareWorkspace } from '../../src/server/create.js';
import type { CloneDeps, RunExecFile } from '../../src/server/create.js';
import { __setGithubAppConfig } from '../../src/server/github.js';
import type { GithubBinding } from '../../src/server/github.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

/** The value that must never be seen outside the child's environment. */
const TOKEN = 'ghs_SECRETVALUE';

const BINDING: GithubBinding = {
  installationId: 7,
  owner: 'acme',
  repo: 'private-thing',
  defaultBranch: 'main',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Same shape as tests/server/github.test.ts — no test touches the network. */
function recordingFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const recorded = { url: String(url), init: init ?? {} };
    calls.push(recorded);
    return handler(recorded.url, recorded.init);
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

interface RecordedRun {
  file: string;
  args: readonly string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number };
}

/**
 * Records every child process the module would have spawned, without spawning
 * one. Recording `options.env` as well as argv is what makes the "token is in
 * the env" assertion possible.
 */
function recordingRun(
  behaviour: (call: RecordedRun) => Promise<{ stdout: string; stderr: string }> = async () => ({
    stdout: '',
    stderr: '',
  }),
): { run: RunExecFile; calls: RecordedRun[] } {
  const calls: RecordedRun[] = [];
  const run: RunExecFile = async (file, args, options) => {
    const call: RecordedRun = { file, args, options };
    calls.push(call);
    return behaviour(call);
  };
  return { run, calls };
}

function cloneDeps(run: RunExecFile, token = TOKEN): CloneDeps {
  const { fetch } = recordingFetch(() => jsonResponse({ token }));
  return { fetch, run };
}

/** Every string a spawned command could carry: the file, each arg, the join. */
function argvStrings(call: RecordedRun): string[] {
  return [call.file, ...call.args, [call.file, ...call.args].join(' ')];
}

beforeEach(() => {
  __setGithubAppConfig({ clientId: 'Iv1.testclientid', clientSecret: 's3cr3t', privateKeyPem: PEM });
});
afterEach(() => __setGithubAppConfig(null));

describe('cloneViaGithubApp', () => {
  it('never puts the clone token into argv', async () => {
    const { run, calls } = recordingRun();
    await cloneViaGithubApp(BINDING, join(tmpdir(), 'nexus-clone-argv'), cloneDeps(run));

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      for (const candidate of argvStrings(call)) {
        expect(candidate).not.toContain(TOKEN);
      }
    }

    // Positive counterpart: the helper SCRIPT is in argv, referring to the
    // token by variable name. If this disappeared, the assertions above could
    // start passing because no credential mechanism exists at all.
    const clone = calls[0];
    expect(clone?.args.join(' ')).toContain('$NEXUS_GH_TOKEN');
    // The empty helper must come first, clearing any inherited system/global
    // helper that would otherwise answer before ours.
    expect(clone?.args.slice(0, 2)).toEqual(['-c', 'credential.helper=']);
  });

  it('keeps the token out of the error when the clone fails', async () => {
    // The realistic failure shape, reconstructed from the argv we actually
    // produced — this is exactly what promisify(execFile) rejects with, and
    // what would land in a broadcast agent_error.
    const { run, calls } = recordingRun(async (call) => {
      throw new Error(
        `Command failed: ${call.file} ${call.args.join(' ')}\n` +
          `remote: Repository not found.\nfatal: repository 'https://github.com/acme/private-thing.git/' not found\n`,
      );
    });

    const failure = await cloneViaGithubApp(
      BINDING,
      join(tmpdir(), 'nexus-clone-fail'),
      cloneDeps(run),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    // It must actually fail — a swallowed error would leave the room pointing
    // at an empty workspace and pass every assertion below vacuously.
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain('Repository not found');
    expect(message).not.toContain(TOKEN);
    expect(String(failure)).not.toContain(TOKEN);
    expect(failure instanceof Error ? (failure.stack ?? '') : '').not.toContain(TOKEN);

    // And nothing ran afterwards that could have persisted a credential.
    expect(calls).toHaveLength(1);
  });

  it('supplies the token to the child through NEXUS_GH_TOKEN', async () => {
    const { run, calls } = recordingRun();
    await cloneViaGithubApp(BINDING, join(tmpdir(), 'nexus-clone-env'), cloneDeps(run));

    expect(calls[0]?.options.env?.['NEXUS_GH_TOKEN']).toBe(TOKEN);
    // The rest of the environment still reaches git — PATH in particular, or
    // the spawn fails on every platform.
    expect(calls[0]?.options.env?.['PATH'] ?? calls[0]?.options.env?.['Path']).toBeDefined();
  });

  it('clones a clean https url carrying no userinfo', async () => {
    const { run, calls } = recordingRun();
    await cloneViaGithubApp(BINDING, join(tmpdir(), 'nexus-clone-url'), cloneDeps(run));

    const urls = (calls[0]?.args ?? []).filter((arg) => arg.startsWith('https://'));
    expect(urls).toEqual(['https://github.com/acme/private-thing.git']);
    const parsed = new URL(urls[0] ?? '');
    expect(parsed.username).toBe('');
    expect(parsed.password).toBe('');
    expect(parsed.host).toBe('github.com');

    // After the clone, the remote is rewritten to the same clean url so
    // nothing credential-shaped can persist in .git/config.
    const setUrl = calls.find((call) => call.args.includes('set-url'));
    expect(setUrl).toBeDefined();
    expect(setUrl?.args).toContain('https://github.com/acme/private-thing.git');
  });
});

describe('token scope', () => {
  /**
   * The clone token is the one credential that reaches a subprocess
   * environment, in a room whose security model is that every participant can
   * do whatever the room can do. It must be read-only on exactly one
   * repository. Swapping `mintCloneToken` for `mintPublishToken` would put a
   * repo-write + PR-write credential there, and without this assertion the
   * whole suite stays green.
   */
  it('mints a read-only, single-repository token for cloning', async () => {
    const { run } = recordingRun();
    const { fetch, calls } = recordingFetch(() => jsonResponse({ token: TOKEN }));
    await cloneViaGithubApp(BINDING, join(tmpdir(), 'nexus-clone-scope'), { fetch, run });

    const mint = calls.find((call) => call.url.includes('/access_tokens'));
    expect(JSON.parse(String(mint?.init.body))).toEqual({
      repositories: ['private-thing'],
      permissions: { contents: 'read' },
    });
  });
});

describe('prepareWorkspace with a GitHub binding', () => {
  /**
   * The binding branch is the entire point of this chunk. Deleting the
   * short-circuit leaves a private-repo room quietly attempting an
   * unauthenticated public clone — which fails for a private repo and, worse,
   * succeeds for a public one, so nothing obviously breaks.
   */
  it('clones through the App rather than anonymously', async () => {
    const base = mkdtempSync(join(tmpdir(), 'nexus-clone-work-'));
    const { run, calls } = recordingRun();
    const { fetch } = recordingFetch(() => jsonResponse({ token: TOKEN }));

    const cwd = await prepareWorkspace('room_with_github', null, base, BINDING, { fetch, run });

    expect(cwd).toContain('room_with_github');
    const clone = calls.find((call) => call.args.includes('clone'));
    expect(clone).toBeDefined();
    // The App path, identified by the credential helper the anonymous path
    // never configures, and by the token reaching the child environment.
    expect(clone?.args.join(' ')).toContain('$NEXUS_GH_TOKEN');
    expect(clone?.options.env?.['NEXUS_GH_TOKEN']).toBe(TOKEN);
    expect(clone?.args).toContain('https://github.com/acme/private-thing.git');
  });

  it('prefers the verified binding over any repoUrl that came with it', async () => {
    const base = mkdtempSync(join(tmpdir(), 'nexus-clone-work-'));
    const { run, calls } = recordingRun();
    const { fetch } = recordingFetch(() => jsonResponse({ token: TOKEN }));

    await prepareWorkspace(
      'room_both',
      'https://github.com/someone/else.git',
      base,
      BINDING,
      { fetch, run },
    );

    const cloned = calls.flatMap((call) => call.args).filter((arg) => arg.startsWith('https://'));
    expect(cloned).toContain('https://github.com/acme/private-thing.git');
    expect(cloned).not.toContain('https://github.com/someone/else.git');
  });
});

describe('prepareWorkspace without a GitHub binding', () => {
  it('still creates a bare workspace when github is null', async () => {
    const base = mkdtempSync(join(tmpdir(), 'nexus-clone-work-'));
    const cwd = await prepareWorkspace('room_no_github', null, base, null);
    expect(cwd).toContain('room_no_github');
    expect(existsSync(cwd)).toBe(true);
  });

  it('still refuses a blocked host on the anonymous path', async () => {
    const base = mkdtempSync(join(tmpdir(), 'nexus-clone-work-'));
    await expect(
      prepareWorkspace('room_blocked', 'https://169.254.169.254/x.git', base, null),
    ).rejects.toThrow(/blocked host/i);
  });
});
