import { beforeAll, describe, expect, it } from 'vitest';
import { createWorkspaceApi } from '../workspaceApi.js';

/**
 * The test the blank-screen bug got past.
 *
 * Every other test in this repo mocks one side of the workspace REST seam, and
 * that is exactly how a wire-format mismatch shipped: the client mocked bare
 * arrays, the server returned `{entries: […]}`, both suites were green, and the
 * room went blank on load in production. Transcribing shapes by hand does not
 * hold a contract — only real bytes from the real server do.
 *
 * So this talks to a RUNNING server and skips itself when there isn't one:
 *
 *   npm run build && PORT=8099 node dist/server/index.js
 *   NEXUS_LIVE_BASE=http://localhost:8099 npm --prefix client test -- liveSeam
 *
 * Skipping-when-absent is deliberate. A live test that fails in CI for want of
 * a server teaches people to ignore it, and an ignored test is worse than none.
 */
// Reached through `globalThis` rather than a bare `process`, deliberately.
// The client is a browser project with no node types, and `client/`'s build is
// `tsc -b && vite build` — which typechecks test files. A bare `process.env`
// here compiles under vitest (esbuild strips types without checking them) and
// then fails `tsc -b` inside the Docker client stage, breaking the deploy but
// nothing a local `npm test` would run. That is exactly how this file broke
// `fly deploy` once already.
const BASE = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  ?.NEXUS_LIVE_BASE;

async function serverIsUp(): Promise<boolean> {
  if (BASE === undefined) return false;
  try {
    const response = await fetch(`${BASE}/`);
    return response.ok;
  } catch {
    return false;
  }
}

const live = (await serverIsUp()) ? describe : describe.skip;

live('workspace REST seam, against a real server', () => {
  let roomId = '';
  let token = '';

  beforeAll(async () => {
    const response = await fetch(`${BASE}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Shape-valid but inert: `POST /api/rooms` only checks the `sk-ant-`
      // prefix, so the room and its workspace exist without a real credential
      // ever being used, and no agent is ever spawned. (I4 — nothing secret.)
      body: JSON.stringify({ apiKey: 'sk-ant-live-seam-test', repoUrl: null }),
    });
    const body = (await response.json()) as { roomId: string; token: string };
    roomId = body.roomId;
    token = body.token;
  });

  function api(): ReturnType<typeof createWorkspaceApi> {
    // The production code builds relative URLs; give it an absolute base so it
    // can run outside a browser without changing the code under test.
    return createWorkspaceApi({
      roomId,
      token,
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) =>
        fetch(`${BASE}${String(input)}`, init)) as typeof fetch,
    });
  }

  it('getTree hands back something FileTree can iterate', async () => {
    const entries = await api().getTree('');
    expect(Array.isArray(entries)).toBe(true);
    // The precise assertion the bug would have failed: FileTree does
    // `for (const entry of dir.entries)`, so a non-iterable throws mid-render.
    expect(() => [...entries]).not.toThrow();
  });

  it('getGitStatus hands back an array, not an envelope', async () => {
    const entries = await api().getGitStatus();
    expect(Array.isArray(entries)).toBe(true);
  });

  it('getModels hands back an array whose ids are under `value`', async () => {
    const models = await api().getModels();
    expect(Array.isArray(models)).toBe(true);
    for (const model of models) expect(typeof model.value).toBe('string');
  });

  it('getGitDiff returns the path it was asked about alongside the diff', async () => {
    const result = await api().getGitDiff('README.md');
    expect(result.path).toBe('README.md');
    expect(typeof result.diff).toBe('string');
  });
});
