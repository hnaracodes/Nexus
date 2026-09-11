import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startAgent } from '../../../src/server/agent.js';
import { __resetRooms, createRoom } from '../../../src/server/rooms.js';
import type { AgentRuntime, ModelChoice } from '../../../src/server/runtime/types.js';

/**
 * The provider-neutral interface, proved against the provider we already have.
 *
 * A second provider is the usual way an interface gets designed — and the usual
 * way it silently absorbs the first provider's assumptions, because nothing
 * forces the abstraction to be honest until a third arrives. So the bar here is
 * deliberately the strict one: **the existing Claude implementation must satisfy
 * `AgentRuntime` with no change to it whatsoever.** If the interface needed
 * `startAgent` edited to fit, the interface would be describing a wish rather
 * than a contract.
 *
 * The type-level half of this file is the real assertion, and it is checked by
 * `npm run verify`, not by vitest — esbuild strips types without checking them,
 * so a conformance break here compiles green under `npm test` alone. The runtime
 * assertions below exist so the file is not silently inert under vitest.
 */

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';
const stubCwd = mkdtempSync(join(tmpdir(), 'nexus-conformance-'));

const stubQuery = (() => ({
  async *[Symbol.asyncIterator]() {
    /* silent */
  },
  interrupt: async () => undefined,
  setModel: async () => undefined,
  supportedModels: async () => [],
})) as never;

function claudeRuntime(): AgentRuntime {
  __resetRooms();
  // The load-bearing line: startAgent's return value is assigned to
  // AgentRuntime with no adapter, no cast and no wrapper. tsc rejects this the
  // moment the two drift.
  const runtime: AgentRuntime = startAgent(
    createRoom({ apiKey: KEY, cwd: stubCwd, repoUrl: null }),
    () => undefined,
    { runQuery: stubQuery },
  );
  return runtime;
}

describe('the Claude implementation conforms to AgentRuntime', () => {
  it('exposes every member the interface requires', () => {
    const runtime = claudeRuntime();
    for (const member of ['submit', 'interrupt', 'stop', 'setModel', 'listModels'] as const) {
      expect(typeof runtime[member], `${member} is missing`).toBe('function');
    }
    expect(runtime.gate, 'the gate is not exposed').toBeDefined();
    expect(typeof runtime.gate.request).toBe('function');
    runtime.stop();
  });

  it('identifies a model by `value`, the name the client is already committed to', () => {
    // Pinned because getting it wrong has already cost this repo a bug. The web
    // client's ModelInfo comment records it: "The identifier field is `value`,
    // not `model` — ModelSelector reads .value, and a `model` field here would
    // have silently produced a dropdown of `undefined` options."
    //
    // Phase 10's first design proposed `SynCodeModelInfo { id, displayName }`,
    // which would have reproduced that bug across every provider at once. The
    // neutral type is the shape both ends already agree on, not a new one.
    const choice: ModelChoice = { value: 'claude-opus-5' };
    expect(choice.value).toBe('claude-opus-5');

    // The SDK's own ModelInfo must remain assignable, or listModels() cannot
    // pass its results straight through.
    const fromSdk: ModelChoice = {
      value: 'claude-sonnet-5',
      displayName: 'Sonnet 5',
      description: 'Fast',
    };
    expect(fromSdk.value).toBe('claude-sonnet-5');
  });
});
