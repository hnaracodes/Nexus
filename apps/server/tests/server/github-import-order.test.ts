import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * Guards a load-bearing IMPORT ORDER, not a function.
 *
 * `src/server/github.ts` reads the GitHub App secrets and deletes them from
 * `process.env` at module-evaluation time, and `src/server/index.ts` imports it
 * **statically** so that happens at boot — before any room can attach an agent.
 * It matters because `startAgent` spawns the SDK subprocess with
 * `env: { ...process.env }`, so anything still in the environment is readable
 * by any participant who asks their agent to run `printenv`. The App private
 * key is a deployment-wide master key that mints installation tokens for every
 * installation.
 *
 * That static import reads as removable — an unused-looking import of a module
 * whose exports are all called later — and its own comment says so. Nothing
 * enforced it until now. This test exists because the phase-8 monorepo move
 * reordered and rewrote every import in the tree, which is exactly the kind of
 * change that would drop it silently: no test would fail, the suite would stay
 * green, and the key would sit in the environment of every agent subprocess.
 */

const SECRETS = ['GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY_B64'] as const;

const ORIGINAL = new Map<string, string | undefined>(
  SECRETS.map((name) => [name, process.env[name]]),
);

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  for (const [name, value] of ORIGINAL) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

it('scrubs the App secrets from process.env merely by importing the server entrypoint', async () => {
  process.env['GITHUB_APP_CLIENT_SECRET'] = 'test-client-secret';
  process.env['GITHUB_APP_PRIVATE_KEY_B64'] = Buffer.from(
    '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----\n',
  ).toString('base64');

  // No call, no createServer() — the import alone must be enough. Awaiting it
  // is what proves the work happened during module evaluation rather than
  // being deferred to a route handler.
  await import('../../src/server/index.js');

  for (const name of SECRETS) {
    expect(process.env[name], `${name} survived import of the server entrypoint`).toBeUndefined();
  }
});

it('scrubs even a half-configured deployment, where the client id is absent', async () => {
  // The delete is unconditional and runs before the completeness check, so a
  // deployment missing GITHUB_APP_CLIENT_ID must still not leave a private key
  // sitting where the agent can read it.
  delete process.env['GITHUB_APP_CLIENT_ID'];
  process.env['GITHUB_APP_PRIVATE_KEY_B64'] = 'not-a-real-key';

  await import('../../src/server/index.js');

  expect(process.env['GITHUB_APP_PRIVATE_KEY_B64']).toBeUndefined();
});
