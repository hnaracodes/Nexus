import { afterEach, describe, expect, it } from 'vitest';
import { readEnv } from '../../src/server/env.js';

/**
 * The rename turned every environment variable into a way to lose the event
 * log. `NEXUS_DATA_DIR` is set in fly.toml and points at the mounted volume; a
 * server that stops reading it silently falls back to a relative `./data`
 * inside the container, boots clean, and writes the authoritative append-only
 * log (I3) somewhere that disappears on the next restart.
 */

const saved = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SYNCODE_TEST') || key.startsWith('NEXUS_TEST')) delete process.env[key];
  }
  Object.assign(process.env, saved);
});

describe('readEnv', () => {
  it('reads the new SYNCODE_ name', () => {
    process.env['SYNCODE_TEST_VALUE'] = 'new';
    expect(readEnv('TEST_VALUE')).toBe('new');
  });

  it('still reads the old NEXUS_ name, so a deployment configured before the rename keeps its volume', () => {
    delete process.env['SYNCODE_TEST_VALUE'];
    process.env['NEXUS_TEST_VALUE'] = 'old';
    expect(readEnv('TEST_VALUE')).toBe('old');
  });

  it('prefers the new name when both are set, so the old one can be removed without a flag day', () => {
    process.env['SYNCODE_TEST_VALUE'] = 'new';
    process.env['NEXUS_TEST_VALUE'] = 'old';
    expect(readEnv('TEST_VALUE')).toBe('new');
  });

  it('is undefined when neither is set, so callers keep their own defaults', () => {
    delete process.env['SYNCODE_TEST_VALUE'];
    delete process.env['NEXUS_TEST_VALUE'];
    expect(readEnv('TEST_VALUE')).toBeUndefined();
  });
});
