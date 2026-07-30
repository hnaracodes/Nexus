import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server/index.js';
import { prepareWorkspace, validateRepoUrl } from '../../src/server/create.js';
import { __resetRateLimits, consumeRateLimit } from '../../src/server/rate-limit.js';
import { roomCount } from '../../src/server/rooms.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

describe('consumeRateLimit', () => {
  beforeEach(() => __resetRateLimits());

  it('allows up to the limit within a window, then refuses', () => {
    const now = 1_000_000;
    expect(consumeRateLimit('k', 3, 10_000, now)).toBe(true);
    expect(consumeRateLimit('k', 3, 10_000, now)).toBe(true);
    expect(consumeRateLimit('k', 3, 10_000, now)).toBe(true);
    expect(consumeRateLimit('k', 3, 10_000, now)).toBe(false);
  });

  it('resets once the window elapses', () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) consumeRateLimit('k', 3, 10_000, now);
    expect(consumeRateLimit('k', 3, 10_000, now)).toBe(false);
    expect(consumeRateLimit('k', 3, 10_000, now + 10_001)).toBe(true);
  });

  it('tracks keys independently', () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) consumeRateLimit('a', 3, 10_000, now);
    expect(consumeRateLimit('a', 3, 10_000, now)).toBe(false);
    expect(consumeRateLimit('b', 3, 10_000, now)).toBe(true);
  });
});

describe('repo host validation blocks private/link-local/metadata addresses', () => {
  it('rejects the cloud metadata address without a DNS lookup', () => {
    const result = validateRepoUrl('https://169.254.169.254/latest/meta-data');
    expect(result.ok).toBe(false);
  });

  it('rejects loopback and localhost', () => {
    expect(validateRepoUrl('https://127.0.0.1/repo.git').ok).toBe(false);
    expect(validateRepoUrl('https://localhost/repo.git').ok).toBe(false);
  });

  it('rejects RFC1918 private ranges', () => {
    expect(validateRepoUrl('https://10.0.0.5/repo.git').ok).toBe(false);
    expect(validateRepoUrl('https://192.168.1.1/repo.git').ok).toBe(false);
    expect(validateRepoUrl('https://172.16.0.1/repo.git').ok).toBe(false);
  });

  it('still accepts an ordinary public host', () => {
    expect(validateRepoUrl('https://github.com/example/repo.git')).toEqual({
      ok: true,
      url: 'https://github.com/example/repo.git',
    });
  });

  it('prepareWorkspace refuses a literal blocked address even if validation were bypassed', async () => {
    const base = mkdtempSync(join(tmpdir(), 'nexus-hardening-'));
    await expect(
      prepareWorkspace('room_hardening_a', 'https://169.254.169.254/latest/meta-data', base),
    ).rejects.toThrow(/blocked host/i);
  });
});

describe('POST /api/rooms is rate-limited, capacity-capped and body-capped', () => {
  let port = 0;
  let started: ReturnType<typeof createServer>;
  const previousLimit = process.env['NEXUS_ROOM_RATE_LIMIT'];
  const previousWindow = process.env['NEXUS_ROOM_RATE_WINDOW_MS'];
  const previousMaxRooms = process.env['NEXUS_MAX_ROOMS'];

  beforeAll(async () => {
    process.env['NEXUS_ROOM_RATE_LIMIT'] = '2';
    process.env['NEXUS_ROOM_RATE_WINDOW_MS'] = '60000';
    started = createServer();
    await new Promise<void>((resolve) => {
      started.server.listen(0, '127.0.0.1', () => {
        port = (started.server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (previousLimit === undefined) delete process.env['NEXUS_ROOM_RATE_LIMIT'];
    else process.env['NEXUS_ROOM_RATE_LIMIT'] = previousLimit;
    if (previousWindow === undefined) delete process.env['NEXUS_ROOM_RATE_WINDOW_MS'];
    else process.env['NEXUS_ROOM_RATE_WINDOW_MS'] = previousWindow;
    if (previousMaxRooms === undefined) delete process.env['NEXUS_MAX_ROOMS'];
    else process.env['NEXUS_MAX_ROOMS'] = previousMaxRooms;
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  });

  afterEach(() => __resetRateLimits());

  // Deliberately NOT the real KEY shape (no "sk-ant-" prefix): rate limiting
  // and the room ceiling are both checked before body validation, so a
  // malformed key still exercises them while getting a 400 instead of ever
  // reaching createRoom/attachRoom — which would start a real SDK session,
  // exactly the thing issues.md §C flags as untested for a reason.
  const BAD_KEY = 'not-a-real-key';

  const create = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('lets the first N requests from one address through, then 429s', async () => {
    const first = await create({ apiKey: BAD_KEY });
    const second = await create({ apiKey: BAD_KEY });
    const third = await create({ apiKey: BAD_KEY });
    expect(first.status).toBe(400); // past rate limit + ceiling, rejected by validateApiKeyShape
    expect(second.status).toBe(400);
    expect(third.status).toBe(429); // rate limit wins before validation even runs
  });

  it('does not count a request from a different address against the same bucket', async () => {
    await create({ apiKey: BAD_KEY });
    await create({ apiKey: BAD_KEY });
    const blocked = await create({ apiKey: BAD_KEY });
    expect(blocked.status).toBe(429);

    const fromElsewhere = await create({ apiKey: BAD_KEY }, { 'X-Forwarded-For': '203.0.113.9' });
    expect(fromElsewhere.status).toBe(400); // its own fresh bucket, not rate-limited
  });

  it('rejects an oversized body with 413 before any validation runs', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Forwarded-For': '203.0.113.10' },
      body: JSON.stringify({ apiKey: BAD_KEY, repoUrl: null, padding: 'x'.repeat(20 * 1024) }),
    });
    expect(response.status).toBe(413);
  });

  it('refuses new rooms once at the configured ceiling, before any validation', async () => {
    const previous = process.env['NEXUS_MAX_ROOMS'];
    process.env['NEXUS_MAX_ROOMS'] = String(roomCount()); // already "full"
    try {
      // A bogus body would normally 400 — 503 proves the ceiling check runs
      // ahead of body validation, so an attacker can't dodge it with garbage.
      const response = await create({}, { 'X-Forwarded-For': '203.0.113.11' });
      expect(response.status).toBe(503);
    } finally {
      if (previous === undefined) delete process.env['NEXUS_MAX_ROOMS'];
      else process.env['NEXUS_MAX_ROOMS'] = previous;
    }
  });
});
