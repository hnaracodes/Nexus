import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  intersectTools,
  readConfig,
  readConfigs,
  readCrew,
  readCrews,
  saveConfig,
  saveCrew,
} from '../../src/server/configStore.js';

/**
 * Phase 13, D2 + D3: configs and crews are user assets persisted outside the
 * event log, and a stored config is executable input on the way OUT as well
 * as in — every read re-validates exactly like every write does.
 */

const VALID = {
  name: 'reviewer',
  description: 'Reviews diffs and comments',
  prompt: 'You review code. Be terse.',
  model: 'claude-sonnet-5',
  tools: ['Read', 'Grep'],
};

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-configstore-'));
});

describe('saveConfig — every write goes through parseAgentConfig', () => {
  it('refuses a config with an unknown field, and writes nothing', () => {
    const result = saveConfig({ ...VALID, somethingNew: 'x' }, dir);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(' ')).toContain('somethingNew');
    // Nothing landed on disk — a rejected write must not leave a file behind
    // for a later read to trust.
    expect(readConfigs(dir)).toEqual([]);
  });

  it('refuses a config omitting `tools`, because omission is the most permissive setting', () => {
    const { tools, ...withoutTools } = VALID;
    void tools;

    const result = saveConfig(withoutTools, dir);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(' ')).toContain('tools');
    expect(readConfigs(dir)).toEqual([]);
  });

  it('accepts and persists a valid config, readable back by name', () => {
    const result = saveConfig(VALID, dir);

    expect(result.ok).toBe(true);
    expect(readConfig('reviewer', dir)).toEqual(VALID);
  });
});

describe('readConfig(s) — re-validated on the way out, because a file on disk is a file on disk', () => {
  it('refuses a config with an unknown field that was already on disk', () => {
    // Hand-written, bypassing saveConfig entirely — this is the shape a
    // hand-edited file, a downgraded server, or a future migration bug could
    // leave behind.
    mkdirSync(join(dir, 'configs'), { recursive: true });
    writeFileSync(
      join(dir, 'configs', 'sneaky.json'),
      JSON.stringify({ ...VALID, name: 'sneaky', permissionMode: 'bypassPermissions' }),
      'utf8',
    );

    expect(readConfig('sneaky', dir)).toBeNull();
    expect(readConfigs(dir)).toEqual([]);
  });

  it('skips a torn/corrupt file and still loads the other configs', () => {
    saveConfig(VALID, dir);
    saveConfig({ ...VALID, name: 'second-reviewer' }, dir);
    mkdirSync(join(dir, 'configs'), { recursive: true });
    // A crash mid-write leaves a truncated, unparsable JSON fragment — this is
    // event-log.ts's "discard the partial trailing line" failure mode, one
    // layer up at the file level instead of the line level.
    writeFileSync(join(dir, 'configs', 'torn.json'), '{"name": "torn", "tools": [', 'utf8');

    const configs = readConfigs(dir);
    expect(configs.map((c) => c.name).sort()).toEqual(['reviewer', 'second-reviewer']);
  });

  it('returns null for a config that was never saved', () => {
    expect(readConfig('nope', dir)).toBeNull();
  });

  it('returns an empty list when nothing has been saved', () => {
    expect(readConfigs(dir)).toEqual([]);
  });
});

describe('intersectTools — a config can only ever narrow the room, never widen it', () => {
  it('yields the intersection of the config’s tools and what the room permits', () => {
    const config = { ...VALID, tools: ['Read', 'Bash', 'Grep'] };

    const narrowed = intersectTools(config, ['Read', 'Grep']);

    expect(narrowed.tools).toEqual(['Read', 'Grep']);
  });

  it('never grants a tool the config itself does not list, even if the room permits it', () => {
    const config = { ...VALID, tools: ['Read'] };

    const narrowed = intersectTools(config, ['Read', 'Bash', 'Grep']);

    expect(narrowed.tools).toEqual(['Read']);
  });

  it('leaves every other field of the config untouched', () => {
    const config = { ...VALID, tools: ['Read', 'Bash'] };

    const narrowed = intersectTools(config, ['Read']);

    expect(narrowed).toMatchObject({
      name: config.name,
      description: config.description,
      prompt: config.prompt,
      model: config.model,
    });
  });
});

describe('crews — a name plus an ordered list of members', () => {
  const CREW = {
    name: 'triage-squad',
    members: [
      { configName: 'reviewer', displayName: 'Rev', provider: 'anthropic', model: 'claude-sonnet-5' },
      { configName: 'triager', displayName: 'Triage', provider: 'openai' },
    ],
  };

  it('accepts and persists a valid crew, readable back by name, in order', () => {
    const result = saveCrew(CREW, dir);

    expect(result.ok).toBe(true);
    expect(readCrew('triage-squad', dir)).toEqual(CREW);
  });

  it('refuses a crew whose member names an unknown provider', () => {
    const result = saveCrew(
      { name: 'bad-crew', members: [{ configName: 'x', displayName: 'X', provider: 'chatgpt' }] },
      dir,
    );

    expect(result.ok).toBe(false);
    expect(readCrews(dir)).toEqual([]);
  });

  it('refuses a crew with an unknown top-level field', () => {
    const result = saveCrew({ ...CREW, name: 'other-crew', launchOnJoin: true }, dir);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(' ')).toContain('launchOnJoin');
  });

  it('re-validates a crew already on disk and skips it if it is invalid, without dropping the rest', () => {
    saveCrew(CREW, dir);
    mkdirSync(join(dir, 'crews'), { recursive: true });
    writeFileSync(join(dir, 'crews', 'hand-edited.json'), '{"name": "hand-edited", "members": [', 'utf8');

    const crews = readCrews(dir);
    expect(crews.map((c) => c.name)).toEqual(['triage-squad']);
  });
});

describe('D3 — nothing written here appears in any event log', () => {
  it('never creates a room log, or any .jsonl file, anywhere under the data dir', () => {
    saveConfig(VALID, dir);
    saveCrew(
      { name: 'triage-squad', members: [{ configName: 'reviewer', displayName: 'Rev', provider: 'anthropic' }] },
      dir,
    );

    // Room event logs live under `<dataDir>/rooms/*.jsonl` (event-log.ts).
    // configStore must never create that directory, let alone a log file in
    // it — a config edit becoming permanent, shareable room history is
    // exactly the leak D3 forbids.
    expect(existsSync(join(dir, 'rooms'))).toBe(false);
    expect(findFiles(dir).filter((f) => f.endsWith('.jsonl'))).toEqual([]);
  });
});

function findFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...findFiles(full));
    else out.push(full);
  }
  return out;
}
