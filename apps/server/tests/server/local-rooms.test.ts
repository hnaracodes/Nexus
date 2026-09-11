/**
 * Integration coverage for phase-17b's `localPath` room creation and the
 * `GET /api/host/addresses` endpoint — the two capabilities `apps/desktop`
 * (17c) drives. Independently `curl`-testable, per the plan: every request
 * below is a real HTTP call against a real listener, never a call straight
 * into a handler function.
 */

import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentDeps } from '../../src/server/agent.js';
import { createServer } from '../../src/server/index.js';
import { __resetLocalHostState } from '../../src/server/localHost.js';
import { __resetRateLimits } from '../../src/server/rate-limit.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

/** Never touches the real SDK — same shape as tests/server/create.test.ts. */
function stubAgentDeps(): AgentDeps {
  return {
    runQuery: (() => ({
      async *[Symbol.asyncIterator]() {
        /* the stub agent never emits */
      },
      interrupt: async () => undefined,
    })) as never,
  };
}

// `run()` returns a Promise wrapping a real network round trip — the env var
// must still be set when the SERVER actually handles the request, not just
// when `fetch()` is first called. A non-async version that only wrapped the
// synchronous call to `run()` restored the env before the request had even
// reached the handler, which made every "accepts" case here fail for the
// wrong reason (403, mode looked off) and would have made every "refuses
// when off" case pass for the wrong reason too, had one existed the same way.
async function withLocalHostMode<T>(run: () => Promise<T>): Promise<T> {
  const original = process.env['NEXUS_LOCAL_HOST'];
  process.env['NEXUS_LOCAL_HOST'] = '1';
  try {
    return await run();
  } finally {
    if (original === undefined) delete process.env['NEXUS_LOCAL_HOST'];
    else process.env['NEXUS_LOCAL_HOST'] = original;
  }
}

describe('POST /api/rooms with localPath', () => {
  let port = 0;
  let started: ReturnType<typeof createServer>;
  let projectDir: string;

  beforeAll(async () => {
    started = createServer({ agentDeps: stubAgentDeps() });
    await new Promise<void>((resolve) => {
      started.server.listen(0, '127.0.0.1', () => {
        port = (started.server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  });

  beforeEach(() => {
    __resetLocalHostState();
    __resetRateLimits();
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-local-project-')));
    writeFileSync(join(projectDir, 'README.md'), '# a real project');
    delete process.env['NEXUS_LOCAL_HOST'];
  });

  afterEach(() => {
    __resetLocalHostState();
    delete process.env['NEXUS_LOCAL_HOST'];
  });

  it('REFUSES localPath when NEXUS_LOCAL_HOST is not set, even though the request is loopback', async () => {
    // The request genuinely arrives from 127.0.0.1 in this test (a real TCP
    // connection) — proving the refusal comes from the mode flag, not the
    // loopback check, is the whole point of this test existing.
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: KEY, localPath: projectDir }),
    });
    expect(response.status).toBe(403);
    // Room must genuinely not have been created against the picked folder.
    const body = (await response.json()) as { roomId?: string };
    expect(body.roomId).toBeUndefined();
  });

  it('accepts localPath when local-host mode is on and the request is loopback, and the room IS that folder', async () => {
    const response = await withLocalHostMode(() =>
      fetch(`http://127.0.0.1:${port}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: KEY, localPath: projectDir }),
      }),
    );
    expect(response.status).toBe(200);
    const { roomId, token } = (await response.json()) as { roomId: string; token: string };
    expect(roomId).toBeTruthy();
    expect(token).toBeTruthy();

    const roomResponse = await fetch(`http://127.0.0.1:${port}/api/rooms/${roomId}`, {
      headers: { 'X-Nexus-Token': token },
    });
    const roomBody = (await roomResponse.json()) as { cwd: string };
    expect(roomBody.cwd).toBe(projectDir);
    // Nothing was cloned or created — the room IS the folder, not a copy.
    expect(existsSync(join(roomBody.cwd, 'README.md'))).toBe(true);
  });

  it('refuses a second room at the same localPath while the first is still live', async () => {
    const first = await withLocalHostMode(() =>
      fetch(`http://127.0.0.1:${port}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: KEY, localPath: projectDir }),
      }),
    );
    expect(first.status).toBe(200);

    const second = await withLocalHostMode(() =>
      fetch(`http://127.0.0.1:${port}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: KEY, localPath: projectDir }),
      }),
    );
    expect(second.status).toBe(400);
  });

  it('refuses a relative or "~"-prefixed localPath even in local-host mode', async () => {
    for (const bad of ['relative/dir', '~/Projects/thing']) {
      const response = await withLocalHostMode(() =>
        fetch(`http://127.0.0.1:${port}/api/rooms`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey: KEY, localPath: bad }),
        }),
      );
      expect(response.status, bad).toBe(400);
    }
  });

  it('refuses combining localPath with a repoUrl', async () => {
    const response = await withLocalHostMode(() =>
      fetch(`http://127.0.0.1:${port}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey: KEY,
          localPath: projectDir,
          repoUrl: 'https://github.com/example/repo.git',
        }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it('refuses a malformed API key before ever touching the filesystem, same as the ordinary path', async () => {
    const response = await withLocalHostMode(() =>
      fetch(`http://127.0.0.1:${port}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: 'hunter2', localPath: projectDir }),
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe('GET /api/host/addresses', () => {
  let port = 0;
  let started: ReturnType<typeof createServer>;

  beforeAll(async () => {
    started = createServer({ agentDeps: stubAgentDeps() });
    await new Promise<void>((resolve) => {
      started.server.listen(0, '127.0.0.1', () => {
        port = (started.server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  });

  async function createRoom(): Promise<{ roomId: string; token: string }> {
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: KEY }),
    });
    return (await response.json()) as { roomId: string; token: string };
  }

  it('401s with no token and with a wrong token — the host LAN topology is not public', async () => {
    const { roomId } = await createRoom();
    const noToken = await fetch(`http://127.0.0.1:${port}/api/host/addresses?room=${roomId}`);
    expect(noToken.status).toBe(401);

    const wrongToken = await fetch(`http://127.0.0.1:${port}/api/host/addresses?room=${roomId}`, {
      headers: { 'X-Nexus-Token': 'not-the-real-token' },
    });
    expect(wrongToken.status).toBe(401);
  });

  it('200s with the right room token, and returns an addresses array', async () => {
    const { roomId, token } = await createRoom();
    const response = await fetch(`http://127.0.0.1:${port}/api/host/addresses?room=${roomId}`, {
      headers: { 'X-Nexus-Token': token },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { addresses: string[] };
    expect(Array.isArray(body.addresses)).toBe(true);
  });
});
