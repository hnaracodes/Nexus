# Phase 3d — Honest Errors and README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Error states that read like sentences rather than stack traces, and a
README that states what Nexus is, its security model, and its MVP limitations
honestly.

**Architecture:** One `toUserMessage()` translation layer maps known failure
shapes to plain sentences and scrubs anything key-shaped from the rest. One
`ErrorBanner` renders server `error` frames.

**Mode:** PARALLEL — dispatch alongside `phase-3b` and `phase-3c`.

**Files owned:** `README.md`, `src/server/errors.ts`, `tests/server/errors.test.ts`,
`client/src/components/ErrorBanner.tsx`, `client/tests/error-banner.test.tsx`,
and the banner slot in `client/src/App.tsx`.

## Global Constraints

- **Verification is not just `npm test`.** Vitest strips types with esbuild and never type-checks. Before every commit, `npm run typecheck` **and** `npm --prefix client run build` (which runs `tsc -b`) must both exit 0.
- **You share `client/src/App.tsx` with two other agents running right now.** It already contains paired marker comments. Edit **only** inside `--- BEGIN phase-3d error banner slot ---` / `--- END ---`, and leave every other marked region byte-for-byte untouched. In the import block (unmarked), add `import { ErrorBanner } from './components/ErrorBanner.js';` immediately after the existing `import { ConnectionStatus } from './components/ConnectionStatus.js';` line — do not re-sort the block.
- **Do not soften the security model.** Both facts go in the README: a shared room is a shared security boundary, and the MVP has no isolation between rooms. Do not market this as multi-tenant.
- **I4 applies to error text.** `toUserMessage` scrubs `sk-ant-…` from every string it returns, including the fallback path. A stack trace is a logging path like any other.
- Every user-facing error is a sentence with a next step. "ECONNREFUSED" is not an error message.
- The README must state that room recovery restores history, **not** the agent's context window.
- Acceptance for this phase: send the link to someone who has never seen the project. They join and participate without asking a single question.

---

### Task 1: Error translation

**Files:**
- Create: `src/server/errors.ts`
- Create: `tests/server/errors.test.ts`
- Modify: `src/server/agent.ts` (one line in the catch block)

**Interfaces:**
- Consumes: nothing.
- Produces: `toUserMessage(error: unknown): string`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/errors.test.ts
import { describe, expect, it } from 'vitest';
import { toUserMessage } from '../../src/server/errors.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

describe('toUserMessage', () => {
  it('explains an authentication failure and what to do', () => {
    const message = toUserMessage(new Error('401 Unauthorized from api.anthropic.com'));
    expect(message).toMatch(/api key/i);
    expect(message).not.toContain('401 Unauthorized from');
  });

  it('explains a rate limit', () => {
    expect(toUserMessage(new Error('429 Too Many Requests'))).toMatch(/rate limit|slow down/i);
  });

  it('explains a connection failure without the errno', () => {
    const message = toUserMessage(new Error('connect ECONNREFUSED 127.0.0.1:443'));
    expect(message).toMatch(/could not reach|connection/i);
    expect(message).not.toContain('ECONNREFUSED');
  });

  it('scrubs a key from an unrecognized error (I4)', () => {
    const message = toUserMessage(new Error(`weird failure using ${KEY}`));
    expect(message).not.toContain('sk-ant');
    expect(message).not.toContain(KEY);
  });

  it('never returns an empty string', () => {
    expect(toUserMessage(undefined).length).toBeGreaterThan(0);
    expect(toUserMessage(null).length).toBeGreaterThan(0);
  });

  it('never returns a stack trace', () => {
    expect(toUserMessage(new Error('boom'))).not.toContain('    at ');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server/errors.test.ts`
Expected: FAIL — cannot resolve `../../src/server/errors.js`.

- [ ] **Step 3: Write `src/server/errors.ts`**

```typescript
/**
 * Translate an internal failure into one sentence a person can act on.
 * This is a logging path, so I4 applies: nothing key-shaped survives.
 */

const API_KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g;

const KNOWN: { match: RegExp; message: string }[] = [
  {
    match: /\b401\b|unauthorized|invalid[_ ]api[_ ]key|authentication/i,
    message:
      'Anthropic rejected this room’s API key. The room creator needs to open a new room with a valid Console key (sk-ant-…).',
  },
  {
    match: /\b429\b|rate[_ ]limit|too many requests/i,
    message:
      'Anthropic is rate limiting this key. Wait a minute and try again, or use a key with more headroom.',
  },
  {
    match: /\b(402|403)\b|credit|quota|billing/i,
    message:
      'This key has no remaining credit or lacks access. Check the balance in the Anthropic Console.',
  },
  {
    match: /econnrefused|enotfound|etimedout|network|fetch failed/i,
    message:
      'Could not reach the Anthropic API. Check the server’s network connection and try again.',
  },
  {
    match: /\b5\d\d\b|overloaded|internal server error/i,
    message: 'Anthropic returned a server error. This is usually temporary — try again shortly.',
  },
];

export function toUserMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');

  for (const known of KNOWN) {
    if (known.match.test(raw)) return known.message;
  }

  // Unknown shape: never pass the raw text through unscrubbed, and never a
  // stack trace. Keep it short and say what to do next.
  const scrubbed = raw.replace(API_KEY_PATTERN, '[redacted]').split('\n')[0] ?? '';
  const detail = scrubbed.trim().slice(0, 200);
  return detail.length > 0
    ? `Something went wrong: ${detail}. Try again, or open a new room if it keeps happening.`
    : 'Something went wrong. Try again, or open a new room if it keeps happening.';
}
```

- [ ] **Step 4: Use it in `src/server/agent.ts`'s error path**

The catch block currently reads:

```typescript
      emit({ type: 'agent_error', message: scrub(String(error), room.getApiKey()) });
```

**Compose, do not replace.** `scrub` splits on the room's *literal* key;
`toUserMessage` only regex-matches `sk-ant-…`. Dropping `scrub` would quietly
weaken I4 on a path that writes to the durable log. Use:

```typescript
      emit({ type: 'agent_error', message: scrub(toUserMessage(error), room.getApiKey()) });
```

`src/server/agent.ts` is contended — change only that one line, add the import,
and list both in your report. Note `room.getApiKey()` throws on a recovered
keyless room; if that turns out to be reachable from this path, report it
rather than removing the scrub.

- [ ] **Step 5: Run tests and commit**

Run: `npm test`
Expected: all pass.

```bash
git add src/server/errors.ts src/server/agent.ts tests/server/errors.test.ts
git commit -m "feat(errors): translate failures into actionable sentences and scrub keys"
```

---

### Task 2: Error banner

**Files:**
- Create: `client/src/components/ErrorBanner.tsx`
- Create: `client/tests/error-banner.test.tsx`
- Modify: `client/src/App.tsx` — render the banner below the header.

**Interfaces:**
- Consumes: nothing beyond React.
- Produces: `ErrorBanner({ message, onDismiss })`.

- [ ] **Step 1: Write the failing test**

```tsx
// client/tests/error-banner.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBanner } from '../src/components/ErrorBanner.js';

describe('ErrorBanner', () => {
  it('renders nothing when there is no message', () => {
    const { container } = render(<ErrorBanner message={null} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the message and dismisses', () => {
    const onDismiss = vi.fn();
    render(<ErrorBanner message="You are not driving." onDismiss={onDismiss} />);
    expect(screen.getByText('You are not driving.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix client test -- tests/error-banner.test.tsx`
Expected: FAIL — cannot resolve `../src/components/ErrorBanner.js`.

- [ ] **Step 3: Write `client/src/components/ErrorBanner.tsx`**

```tsx
export function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}): JSX.Element | null {
  if (message === null) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-between rounded bg-rose-50 px-3 py-2 text-sm text-rose-800"
    >
      <span>{message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="ml-4 underline">
        Dismiss
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Wire it into `client/src/App.tsx`**

`RoomView` already carries the error for you — `store.ts` was fixed on master
and now exposes `lastError: string | null` plus `errorCount: number`. **You do
not need to touch `client/src/ws.ts` or `client/src/store.ts`, and the earlier
instruction to report BLOCKED about them is obsolete.**

Dismiss by remembering *which* error was dismissed, not whether one was:

```tsx
  const [dismissedCount, setDismissedCount] = useState(0);
  const bannerMessage = view.errorCount > dismissedCount ? view.lastError : null;
```

```tsx
      {/* --- BEGIN phase-3d error banner slot --- */}
      <ErrorBanner message={bannerMessage} onDismiss={() => setDismissedCount(view.errorCount)} />
      {/* --- END phase-3d error banner slot --- */}
```

The counter is load-bearing. `"You are not driving"` is the most common error
in the product and a non-driver hits it repeatedly; comparing message text
alone would swallow every repeat after the first dismissal. Add a test for
exactly that: dismiss, receive the same message again, banner returns.

- [ ] **Step 5: Run tests and commit**

Run: `npm --prefix client test`
Expected: all pass.

```bash
git add client/src/components/ErrorBanner.tsx client/src/App.tsx client/tests/error-banner.test.tsx
git commit -m "feat(client): dismissible error banner for server error frames"
```

---

### Task 3: README

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: the deployed URL and Fly app name from `phase-1c`'s report.
- Produces: the repo's front door.

- [ ] **Step 1: Write `README.md`**

Everything below is final copy — do not soften the two limitation sections.

**Nothing has ever been deployed.** There is no `fly` CLI and no credentials on
this machine, and `fly.toml` has never been applied. Do **not** print a live
URL as though it works. Replace the `**Live:**` line with a plain statement
that the project runs locally and has not been deployed yet, or drop it.

Also: the quick-start block says `:8080`, but port 8080 is occupied on the
primary dev machine by an unrelated server. Use `PORT=8099 npm run dev` and say
why in one clause, or a first-time reader gets someone else's 404.

````markdown
# Nexus

Nexus turns an AI coding session from a process into a room. Several people
open one link, watch the same live agent output, take turns driving, and
collectively approve or block risky tool calls — against **one agent process
holding one context window**. Nobody screen-shares. Nobody re-explains context.

Collaboration is the mechanism. Governance is the product.

**Live:** https://nexus-mvp.fly.dev

## What it does

- **One room, one agent.** A room owns exactly one Claude Agent SDK session. Joining never forks or restarts it.
- **One driver at a time**, enforced at the server. A non-driver's input is rejected by the server, not just greyed out in the UI. Control can be requested, granted, and released; if the driver disconnects, the token frees after 30 seconds.
- **Collective approval on risky actions.** File writes, `Bash`, and anything outside the read-only allow-list suspend the agent and prompt the whole room. Anyone can approve or deny; the first response wins and the decider's name goes in the log. Nobody responding within two minutes means denied — never hung.
- **Everything is logged.** Every prompt, message, tool call, handoff, decision, join, and leave is appended to a per-room JSONL file with a monotonic sequence number. Reconnect, rejoin, and restart all reconstruct from that log.
- **Anyone can stop it.** The stop button is not gated on the driver token.

## Quick start

```bash
npm install
npm --prefix client install
npm run dev                    # server on :8080
npm --prefix client run dev    # client on :5173
npm test                       # server tests
npm --prefix client test       # client tests
```

Open the client, paste an Anthropic **Console** API key, and share the link it
gives you.

## Security model — read this before sharing a link

**A shared room is a shared security boundary.** Whatever the room can do,
every participant in it can do: read your `.env`, use your git credentials, run
shell commands. The permission gate makes those actions *visible and vetoable*
— it does not contain them. Rooms are invite-only-among-people-you-trust. Do
not post a room link publicly.

**There is no isolation between rooms.** One host process, one filesystem. Room
A can in principle reach room B's working directory. This is an accepted
tradeoff for this preview. Nexus is **not** multi-tenant, and you should not
run it as a shared service for people who don't know each other. Per-room
sandboxes are the fix, and they are not built yet.

**API keys.** The room creator supplies an Anthropic Console API key
(`sk-ant-…`). It is POSTed once over HTTPS, held in memory on the server, used
only to construct the SDK client, and never sent to any client, written to the
event log, or placed in a URL. It is **not** persisted: after a server restart,
a recovered room asks for the key again.

Claude Free, Pro, and Max subscription logins cannot be used. Anthropic's terms
prohibit third-party developers from routing requests through plan credentials
on a user's behalf.

## Known limitations

- **No isolation between rooms** (above).
- **Recovery restores history, not memory.** After a restart the room and its full transcript come back, but the key was never persisted — so the room refuses connections until its creator re-supplies one, and only then does the history replay. The agent's context window does not come back either way: it starts fresh and does not remember the earlier conversation.
- **Two people can contradict each other.** Prompts are attributed by name so the agent can reason about competing instructions, but nothing arbitrates them. This is a real limitation, not a bug.
- **Streaming text is not replayed.** Only completed assistant messages are logged. A late joiner sees an in-flight message once it finishes, not as it types.
- **No accounts.** The link is the credential. Anyone with the link is in the room.
- **Identity survives a reconnect, but only in the same browser.** A refresh or a dropped connection keeps your roster row and the driver token, because the browser stores an identity for the room. A different browser, a private window, or cleared storage is a new person.

## Architecture

The server broadcasts the Agent SDK's **structured event stream** — not a PTY.
That single decision removes terminal resize arbitration across differently
sized browser windows, ANSI resynchronization for late joiners, scrollback
replay, and the whole class of "two people typed and the bytes interleaved"
bugs. It also produces semantically meaningful events to log, replay, and
attribute, which a byte stream cannot.

- `src/protocol/` — the frozen event union and wire frames
- `src/server/` — rooms, the single `query()` instance, WebSocket transport, driver token, permission gate
- `src/log/` — append-only JSONL, redaction, replay
- `client/` — React projection of the event stream
- `docs/plans/` — the implementation plans this was built from

## License

MIT
````

- [ ] **Step 2: Verify the honesty claims against the code**

Check each limitation is still true before committing. If any is now false, fix
the README — do not weaken the claim to match.

```bash
grep -rn "sk-ant" src/ client/src/ | grep -v TESTONLY
```
Expected: no key assigned into any logged or serialized path.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README stating the security model and MVP limitations plainly"
```

---

## Report notes

- The one line changed in `src/server/agent.ts` (contended file), plus the import.
- Whether capturing `error` frames in `App.tsx` needed a change to `client/src/ws.ts`, and the exact diff if so.
- Any README limitation that turned out to be false, and what you changed.
