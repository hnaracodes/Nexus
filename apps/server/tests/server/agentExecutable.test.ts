import { describe, expect, it } from 'vitest';
import { agentExecutablePath, electronRunAsNodeEnv } from '../../src/server/agentExecutable.js';

/**
 * Found live: "Failed to spawn Claude Code process: spawn node ENOENT" on a
 * real desktop install. The Claude Agent SDK spawns the bare string "node"
 * and resolves it through PATH; a Finder-launched app's PATH comes only from
 * `/etc/paths` + `/etc/paths.d/*`, never a shell rc file, so nvm/asdf/volta/
 * fresh-Homebrew installs of Node are invisible to it. `process.execPath` is
 * the fix: the exact binary already running this process, no PATH lookup.
 * `ELECTRON_RUN_AS_NODE` is what makes that path (the Electron binary itself
 * inside the desktop app) behave as plain Node instead of trying to launch a
 * second app instance.
 */
describe('agentExecutablePath', () => {
  it('defaults to this process’s own execPath — no PATH lookup involved', () => {
    expect(agentExecutablePath()).toBe(process.execPath);
  });

  it('accepts an injected path, for tests that need a specific value', () => {
    expect(agentExecutablePath('/custom/node')).toBe('/custom/node');
  });
});

describe('electronRunAsNodeEnv', () => {
  it('is empty on a plain Node process — the real condition on the hosted server and in every test', () => {
    expect(electronRunAsNodeEnv({ electron: undefined })).toEqual({});
  });

  it('sets ELECTRON_RUN_AS_NODE when running inside Electron', () => {
    expect(electronRunAsNodeEnv({ electron: '44.0.0' })).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('defaults to the real process.versions, matching whichever runtime is actually executing', () => {
    // In this test suite that is plain Node, so electron is genuinely absent —
    // asserting on the REAL global rather than a stand-in for it.
    expect(electronRunAsNodeEnv()).toEqual(
      process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' },
    );
  });
});
