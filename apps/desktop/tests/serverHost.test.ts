import { createServer as createHttpServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { resolveListenPort, serverOrigin } from '../src/serverHost.js';

describe('resolveListenPort', () => {
  it('throws when the server has not started listening (address() is null)', () => {
    expect(() => resolveListenPort(null)).toThrow(/not listening/i);
  });

  it('throws for a pipe/socket path rather than mis-reading it as a port', () => {
    expect(() => resolveListenPort('/tmp/some.sock')).toThrow(/pipe\/socket/i);
  });

  it('extracts the OS-assigned port from a real ephemeral listener', async () => {
    // No mock: this is the one place worth spinning up a real port-0 server,
    // since the whole point of resolveListenPort is bridging the gap between
    // `.listen(0, …)` and whatever port the OS actually handed back.
    const server = createHttpServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    try {
      const port = resolveListenPort(server.address());
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65536);
      expect(serverOrigin(port)).toBe(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('serverOrigin', () => {
  it('always binds to the loopback literal, never "localhost"', () => {
    expect(serverOrigin(54321)).toBe('http://127.0.0.1:54321');
  });
});
