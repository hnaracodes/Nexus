/**
 * The runtime construction seam (phase 10).
 *
 * An earlier design review proposed `AgentRuntimeFactory(deps)` — a factory
 * taking only an injection-seam object — and found it could not be implemented
 * by the function it was meant to describe. `startAgent` (`../agent.ts`) needs
 * `room.cwd`, `room.id`, a LIVE `room.driverId` read at every `deliver()` call,
 * `room.getApiKey()`, and `deps.readEvents`; none of that fits through a
 * `deps`-only signature, and the same is true of `startOpenAiAgent` and
 * `startGeminiAgent`. So `createRuntime` takes `room` and `emit` as their own
 * arguments and forwards them UNCOPIED to whichever provider function does the
 * work — the same three positions `startAgent`/`startOpenAiAgent`/
 * `startGeminiAgent` already require. Forwarding the live `room` object,
 * rather than reading fields off it here and passing values, is what keeps a
 * later mutation of `room.driverId` visible to the runtime's next `deliver()`
 * call (I2′ — driver precedence is decided by the LIVE token, not a snapshot
 * taken at construction).
 *
 * This file does NOT memoize. `attachAgent` (I1, re-scoped to per-agent in
 * phase 8b) is the one place allowed to call this at most once per agent id
 * and hold onto the result. A factory that cached by room+provider on its own
 * would silently hand a second caller the same `query()` even when the room
 * legitimately wants a second, independent agent of the same provider — the
 * exact fork I1 forbids, reintroduced by a caching layer nobody asked for.
 */
import type { AgentProvider } from '@nexus/protocol/events';
import type { AgentDeps, EmitFn } from '../agent.js';
import { startAgent } from '../agent.js';
import type { Room } from '../rooms.js';
import type { GeminiDeps } from './gemini.js';
import { startGeminiAgent } from './gemini.js';
import type { OpenAiDeps } from './openai.js';
import { startOpenAiAgent } from './openai.js';
import type { AgentRuntime } from './types.js';

/**
 * `AgentDeps` (Claude's own injection seam) plus one nested seam per other
 * provider, rather than one flat bag of optional fields.
 *
 * The three providers' deps overlap only in NAME, not in type —
 * `AgentDeps.runQuery` is the Claude Agent SDK's `query` entry point;
 * `GeminiDeps.client` and `OpenAiDeps.client` are two unrelated client
 * interfaces that happen to both be called `client`. Flattening all three
 * into one interface would force a caller to know, field by field, which
 * provider each one belongs to, and would let a Gemini-only field compile
 * against an OpenAI call. Nesting keeps each provider's seam exactly as its
 * own module already declared it, and a test wires up exactly one of
 * `deps`, `deps.openai` or `deps.google` — whichever provider it is testing.
 */
export interface RuntimeDeps extends AgentDeps {
  /** Test seam for the OpenAI adapter (`./openai.ts`). Ignored by the other two arms. */
  openai?: OpenAiDeps;
  /** Test seam for the Google/Gemini adapter (`./gemini.ts`). Ignored by the other two arms. */
  google?: GeminiDeps;
}

/**
 * Construct the one `AgentRuntime` for an agent, dispatching on its provider.
 *
 * The switch is written to fail to COMPILE, not just to fail a test, the
 * moment a fourth provider is added to `AgentProvider` without a matching arm
 * here — see the `never` assignment in `default` below. That is deliberate:
 * the alternative (a `default` that falls through to Claude) would mean a
 * room configured for the new provider silently spends the Anthropic key
 * instead, which is a billing lie and an attribution lie, not merely a bug.
 */
export function createRuntime(args: {
  provider: AgentProvider;
  room: Room;
  emit: EmitFn;
  deps?: RuntimeDeps;
}): AgentRuntime {
  const { provider, room, emit, deps = {} } = args;
  switch (provider) {
    case 'anthropic':
      return startAgent(room, emit, deps);
    // `visibility` is a ROOM-level concern (the approval queue every agent in
    // the room shares), so it lives on the shared deps rather than inside a
    // per-provider bag — but each adapter builds its own gate, so it has to be
    // forwarded into each. Spread AFTER the provider deps so a test that
    // supplies its own still wins.
    case 'openai':
      return startOpenAiAgent(room, emit, {
        ...deps.openai,
        ...(deps.visibility === undefined ? {} : { visibility: deps.visibility }),
      });
    case 'google':
      return startGeminiAgent(room, emit, {
        ...deps.google,
        ...(deps.visibility === undefined ? {} : { visibility: deps.visibility }),
      });
    default: {
      // Exhaustiveness check. If `AgentProvider` (packages/protocol/src/events.ts)
      // ever grows a fourth member, `provider` stops being assignable to
      // `never` here and THIS FILE fails `npm run typecheck` — a new provider
      // must be wired in deliberately, not fall through into whichever arm
      // happens to be last.
      const exhaustive: never = provider;
      // Reachable at RUNTIME even though the type says `never`: a value read
      // back off the log or off disk and cast `as AgentProvider` (a malformed
      // persisted value) is not guaranteed to actually be one. Throwing here,
      // rather than defaulting to any provider, is what stops that from
      // turning into a room that thinks it is running OpenAI while actually
      // spending an Anthropic key.
      throw new Error(`createRuntime: unknown agent provider ${JSON.stringify(exhaustive)}`);
    }
  }
}
