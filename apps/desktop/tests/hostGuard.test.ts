import { describe, expect, it } from 'vitest';
import { describeHostConflict } from '../src/hostGuard.js';

/**
 * `describeHostConflict` is the pure decision behind the fix for: closing a
 * hosted room's window (or the dock icon's `activate`) must never let a
 * second "Open a folder" silently start a second backend and strand the
 * first one running with no UI path back to it. See hostGuard.ts's own
 * header for the full scenario.
 */
describe('describeHostConflict', () => {
  it('allows opening a folder when nothing is hosted yet', () => {
    expect(describeHostConflict(undefined)).toEqual({ blocked: false });
  });

  it('refuses when a room is already hosted, naming the exact folder', () => {
    const result = describeHostConflict({ folderName: 'nexus' });
    expect(result.blocked).toBe(true);
    if (!result.blocked) return;
    expect(result.message).toContain('nexus');
  });

  it('tells the user how to get back to the room already running', () => {
    const result = describeHostConflict({ folderName: 'nexus' });
    if (!result.blocked) throw new Error('expected a refusal');
    expect(result.message.toLowerCase()).toContain('dock');
  });

  it('tells the user how to actually stop the already-running server', () => {
    const result = describeHostConflict({ folderName: 'nexus' });
    if (!result.blocked) throw new Error('expected a refusal');
    expect(result.message.toLowerCase()).toContain('quit');
  });

  it('never silently proceeds when a room is already hosted', () => {
    // A guard that sometimes returns blocked:false for a defined `existing`
    // is no guard at all — this is the property the whole fix rests on.
    for (const folderName of ['a', 'a different project', '日本語', '']) {
      expect(describeHostConflict({ folderName }).blocked).toBe(true);
    }
  });
});
