/**
 * Tests for the phase-11 collaborative document layer (`src/server/docs.ts`).
 *
 * Real temp directories throughout, the same way `workspace.test.ts` tests
 * the jail this module builds on: a mocked filesystem cannot demonstrate a
 * real escaping path, and a mocked CRDT cannot demonstrate a real merge.
 *
 * Every test that needs to inspect a document's live text does so through
 * `open()` — the only read path the public interface offers — by decoding the
 * returned change bundle into a throwaway Automerge doc. This is deliberate:
 * it exercises exactly what a real second client would do, rather than
 * reaching into the module's private state.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Automerge from '@automerge/automerge';
import { beforeEach, describe, expect, it } from 'vitest';
import type { UnsequencedEvent } from '@syncode/protocol/events';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';
import { WorkspacePathError } from '../../src/server/workspace.js';
import {
  createDocRegistry,
  decodeChangeBundle,
  encodeChangeBundle,
  type DocRegistry,
} from '../../src/server/docs.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

beforeEach(() => __resetRooms());

function makeRoom(cwd: string) {
  return createRoom({ apiKey: KEY, cwd, repoUrl: null });
}

/** A fresh `<tmp>/room` directory containing `file`, plus a sibling
 *  `<tmp>/secret.txt` OUTSIDE it — the same escaping-path fixture
 *  `workspace.test.ts` uses, so the jail is exercised against a real file
 *  that exists but is genuinely outside the root, not merely absent. */
function fixture(fileName: string, content: string) {
  const base = mkdtempSync(join(tmpdir(), 'nexus-docs-'));
  const root = join(base, 'room');
  mkdirSync(root);
  writeFileSync(join(root, fileName), content, 'utf8');
  writeFileSync(join(base, 'secret.txt'), 'outside the jail', 'utf8');
  return { base, root };
}

function collectEmitted(): { emit: (e: UnsequencedEvent) => void; events: UnsequencedEvent[] } {
  const events: UnsequencedEvent[] = [];
  return { emit: (e) => events.push(e), events };
}

/** Reads a document's current merged text through the only read path the
 *  public interface exposes: open a fresh observer peer and decode the full
 *  history it hands back. */
async function currentText(registry: DocRegistry, room: ReturnType<typeof makeRoom>, path: string): Promise<string> {
  const { payload } = await registry.open(room, path, `observer-${Math.random().toString(36).slice(2)}`);
  const doc = Automerge.applyChanges(Automerge.init<{ text: string }>(), decodeChangeBundle(payload))[0];
  return doc.text;
}

/** Simulates one remote peer's own Automerge replica: bootstraps from an
 *  `open()` payload, and turns a local edit into the same change-bundle
 *  format `applySync` expects — exactly what a real second client would send
 *  over `doc_sync`. */
class FakePeer {
  #doc: Automerge.Doc<{ text: string }>;

  constructor(initialPayloadBase64: string) {
    this.#doc = Automerge.applyChanges(
      Automerge.init<{ text: string }>(),
      decodeChangeBundle(initialPayloadBase64),
    )[0];
  }

  get text(): string {
    return this.#doc.text;
  }

  /** Replace the whole text locally and return the resulting sync payload. */
  edit(newText: string): string {
    const before = Automerge.getHeads(this.#doc);
    this.#doc = Automerge.change(this.#doc, (d) => {
      Automerge.updateText(d, ['text'], newText);
    });
    const changes = Automerge.getChangesSince(this.#doc, before);
    return encodeChangeBundle(changes);
  }

  receive(payloadBase64: string): void {
    this.#doc = Automerge.applyChanges(this.#doc, decodeChangeBundle(payloadBase64))[0];
  }
}

describe('createDocRegistry', () => {
  it('merges two peers editing the same document concurrently, surviving both edits', async () => {
    const { root } = fixture('shared.txt', 'hello world');
    const room = makeRoom(root);
    const { emit } = collectEmitted();
    const registry = createDocRegistry(emit);

    const { payload: payloadA } = await registry.open(room, 'shared.txt', 'participant-a');
    const { payload: payloadB } = await registry.open(room, 'shared.txt', 'participant-b');
    const peerA = new FakePeer(payloadA);
    const peerB = new FakePeer(payloadB);

    const bundleA = peerA.edit('hello wonderful world');
    const bundleB = peerB.edit('hello world, everyone');

    await registry.applySync(room, 'shared.txt', bundleA, 'participant-a');
    await registry.applySync(room, 'shared.txt', bundleB, 'participant-b');

    const merged = await currentText(registry, room, 'shared.txt');
    expect(merged).toContain('wonderful');
    expect(merged).toContain('everyone');
  });

  it('does not let an agent whole-file write clobber a concurrent human edit', async () => {
    const { root } = fixture('a.txt', 'line1\nline2\nline3\n');
    const room = makeRoom(root);
    const { emit } = collectEmitted();
    const registry = createDocRegistry(emit, { flushDebounceMs: 10_000 }); // keep knownHeads pinned to creation

    const { payload } = await registry.open(room, 'a.txt', 'human-1');
    const human = new FakePeer(payload);

    // The human's concurrent edit lands in the live document first.
    const humanBundle = human.edit('line1\nLINE2-CHANGED-BY-HUMAN\nline3\n');
    await registry.applySync(room, 'a.txt', humanBundle, 'human-1');

    // The agent's write is computed from the file as it read it BEFORE the
    // human's edit was known to it — the actual race this test exists for.
    await registry.applyAgentEdit(room, 'a.txt', 'agent-1', 'line1\nline2\nLINE3-CHANGED-BY-AGENT\n');

    const merged = await currentText(registry, room, 'a.txt');
    expect(merged).toContain('LINE2-CHANGED-BY-HUMAN');
    expect(merged).toContain('LINE3-CHANGED-BY-AGENT');
  });

  it('reconcileExternal merges a git-checkout-shaped replacement rather than overwriting a concurrent local edit', async () => {
    const { root } = fixture('a.txt', 'line1\nline2\nline3\n');
    const room = makeRoom(root);
    const { emit } = collectEmitted();
    const registry = createDocRegistry(emit, { flushDebounceMs: 10_000 });

    const { payload } = await registry.open(room, 'a.txt', 'human-1');
    const human = new FakePeer(payload);
    const humanBundle = human.edit('line1\nline2\nline3\n\nAPPENDED-BY-HUMAN');
    await registry.applySync(room, 'a.txt', humanBundle, 'human-1');

    // A git checkout that reverted line1, computed from the ORIGINAL disk
    // content — it has no idea the human appended anything.
    await registry.reconcileExternal(room, 'a.txt', 'REVERTED-LINE1\nline2\nline3\n');

    const merged = await currentText(registry, room, 'a.txt');
    expect(merged).toContain('REVERTED-LINE1');
    expect(merged).toContain('APPENDED-BY-HUMAN');
  });

  it('does not flush or log file_edited twice when reconcileExternal reports content it just flushed itself', async () => {
    const { root } = fixture('a.txt', 'hello');
    const room = makeRoom(root);
    const { emit, events } = collectEmitted();
    const registry = createDocRegistry(emit, { flushDebounceMs: 15 });

    const { payload } = await registry.open(room, 'a.txt', 'human-1');
    const human = new FakePeer(payload);
    const bundle = human.edit('hello world');
    await registry.applySync(room, 'a.txt', bundle, 'human-1');

    // Let the debounced flush actually run.
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('hello world');
    const fileEditedAfterFlush = events.filter((e) => e.type === 'file_edited');
    expect(fileEditedAfterFlush).toHaveLength(1);

    // The watcher reports back exactly the content we just wrote ourselves.
    await registry.reconcileExternal(room, 'a.txt', 'hello world');
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('hello world');
    expect(events.filter((e) => e.type === 'file_edited')).toHaveLength(1);
  });

  it('keeps two rooms with a file at the same relative path from sharing a document', async () => {
    const { root: rootA } = fixture('shared.txt', 'room A original');
    const { root: rootB } = fixture('shared.txt', 'room B original');
    const roomA = makeRoom(rootA);
    const roomB = makeRoom(rootB);
    const { emit } = collectEmitted();
    const registry = createDocRegistry(emit);

    const { payload } = await registry.open(roomA, 'shared.txt', 'participant-a');
    await registry.open(roomB, 'shared.txt', 'participant-b');

    const peer = new FakePeer(payload);
    const bundle = peer.edit('room A EDITED');
    await registry.applySync(roomA, 'shared.txt', bundle, 'participant-a');

    expect(await currentText(registry, roomA, 'shared.txt')).toBe('room A EDITED');
    expect(await currentText(registry, roomB, 'shared.txt')).toBe('room B original');
  });

  it('refuses a path that escapes the workspace root', async () => {
    const { root } = fixture('hello.txt', 'hi');
    const room = makeRoom(root);
    const { emit } = collectEmitted();
    const registry = createDocRegistry(emit);

    await expect(registry.open(room, '../secret.txt', 'participant-a')).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
  });

  it('never logs a doc_sync event, and logs far fewer snapshots than edits', async () => {
    const { root } = fixture('log.txt', '');
    const room = makeRoom(root);
    const { emit, events } = collectEmitted();
    // A tiny size trigger and an effectively infinite cadence isolate the
    // size half of "cadence AND size trigger" so the test is deterministic
    // regardless of how fast it runs.
    const registry = createDocRegistry(emit, {
      // Each tiny text edit still costs ~115 bytes of Automerge change
      // overhead (actor id, hashes, ops) regardless of how few characters
      // changed, so the trigger has to clear that floor by a comfortable
      // margin or every single edit would cross it.
      snapshotSizeTriggerBytes: 500,
      snapshotIntervalMs: 1_000_000,
      flushDebounceMs: 10_000,
    });

    const { payload } = await registry.open(room, 'log.txt', 'participant-a');
    const peer = new FakePeer(payload);

    const editCount = 20;
    let text = '';
    for (let i = 0; i < editCount; i += 1) {
      text += `edit-${i};`;
      const bundle = peer.edit(text);
      await registry.applySync(room, 'log.txt', bundle, 'participant-a');
    }

    const docSyncEvents = events.filter((e) => (e as { type: string }).type === 'doc_sync');
    expect(docSyncEvents).toHaveLength(0);

    const snapshotCount = events.filter((e) => e.type === 'doc_snapshot').length;
    expect(snapshotCount).toBeGreaterThan(0);
    expect(snapshotCount).toBeLessThan(editCount / 2);
  });

  it('cannot assume saveIncremental() is smaller than save() after a fresh load (verified 2026-09-06)', () => {
    // Direct verification of the landmine documented in CLAUDE.md and in
    // docs.ts's snapshot comment, reproduced against the real installed
    // Automerge (3.4.1), not asserted from memory. This is exactly why the
    // snapshot logic always logs save()'s output rather than trying to save
    // bandwidth with saveIncremental().
    let doc = Automerge.from({ text: 'line1\nline2\nline3\n' });
    doc = Automerge.change(doc, (d) => {
      Automerge.updateText(d, ['text'], 'line1\nline2 modified a bit more\nline3\n');
    });
    doc = Automerge.change(doc, (d) => {
      Automerge.updateText(d, ['text'], 'line1\nline2 modified a bit more\nline3\nextra tail content here\n');
    });

    const full = Automerge.save(doc);
    const fresh = Automerge.load(full);
    const incremental = Automerge.saveIncremental(fresh);

    expect(incremental.byteLength).toBeGreaterThan(full.byteLength);
  });
});
