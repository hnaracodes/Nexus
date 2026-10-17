import { describe, expect, it } from 'vitest';
import { PRESETS, presetConfigBody, uniqueName } from '../presets.js';

// A literal copy of apps/server/src/server/agentConfig.ts ALLOWED_FIELDS —
// cross-package imports are not possible, so a drift here is a deliberate edit.
const ALLOWED = ['name', 'description', 'prompt', 'model', 'tools', 'mcpServers', 'agents'];

describe('PRESETS', () => {
  it('every preset body passes the server allow-list shape', () => {
    for (const p of PRESETS) {
      const body = presetConfigBody(p);
      expect(Object.keys(body).every((k) => ALLOWED.includes(k))).toBe(true);
      expect(typeof body.name).toBe('string');
      expect(body.name).not.toBe('');
      expect(typeof body.description).toBe('string');
      expect(typeof body.prompt).toBe('string');
      expect(Array.isArray(body.tools) && body.tools.every((t) => typeof t === 'string')).toBe(true);
      expect(body).not.toHaveProperty('provider');
    }
  });

  it('has the four named presets with unique names and keys', () => {
    expect(PRESETS.map((p) => p.name)).toEqual(['Planner', 'Coder', 'Reviewer', 'Tester']);
    expect(new Set(PRESETS.map((p) => p.key)).size).toBe(PRESETS.length);
  });

  it('the body copies tools so a caller cannot mutate the preset', () => {
    const body = presetConfigBody(PRESETS[0]!);
    body.tools.push('Bash');
    expect(PRESETS[0]!.tools).not.toContain('Bash');
  });

  it('never promises a guarantee in descriptions', () => {
    for (const p of PRESETS) expect(p.description + p.prompt).not.toMatch(/approved|trusted|auto-/i);
  });
});

describe('uniqueName', () => {
  it('returns the base when nothing is taken', () => {
    expect(uniqueName('Coder', [])).toBe('Coder');
  });
  it('counts up from 2', () => {
    expect(uniqueName('Coder', ['Coder'])).toBe('Coder 2');
    expect(uniqueName('Coder', ['Coder', 'Coder 2'])).toBe('Coder 3');
  });
  it('fills a gap', () => {
    expect(uniqueName('Coder', ['Coder', 'Coder 3'])).toBe('Coder 2');
  });
  it('compares case-insensitively', () => {
    expect(uniqueName('Coder', ['coder'])).toBe('Coder 2');
  });
  it('never exceeds 80 characters', () => {
    const long = 'x'.repeat(80);
    const a = uniqueName(long, []);
    expect(a.length).toBe(80);
    const b = uniqueName(long, [a]);
    expect(b.length).toBeLessThanOrEqual(80);
    expect(b.endsWith(' 2')).toBe(true);
    expect(uniqueName('y'.repeat(200), []).length).toBe(80);
  });
});
