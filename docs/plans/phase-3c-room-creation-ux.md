# Phase 3c — Room Creation UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A landing page where someone pastes an Anthropic Console API key,
optionally a git repo URL, and gets a shareable room link — with the security
model stated on the page, not buried in a README.

**Architecture:** The key is POSTed once over HTTPS and never leaves the
server. Repo cloning happens into a per-room working directory before the agent
is attached. The room link carries the room id and token — never the key.

**Mode:** PARALLEL — dispatch alongside `phase-3b` and `phase-3d`.

**Files owned:** `src/server/create.ts`, `tests/server/create.test.ts`,
`client/src/pages/CreateRoom.tsx`, `client/tests/create-room.test.tsx`, and the
route switch in `client/src/App.tsx`.

## Global Constraints

- **I4, and it is also a legal constraint.** The key must be an Anthropic **Console** API key (`sk-ant-…`). Anthropic's terms state verbatim: *"Anthropic does not permit third-party developers to offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf of their users."* Never build a subscription-login path.
- The key travels in a POST body over HTTPS, once. Never in a URL, never in `localStorage`, never in an error message, never echoed back in a response.
- **Say the security model on the creation page, not only in the README.** A shared room is a shared security boundary: whatever the room can do, every participant can do — read `.env`, use git credentials, run commands. Rooms are invite-only-among-people-you-trust.
- Clone into a per-room directory under `NEXUS_WORKDIR` (default `./work`). Never clone into the server's own checkout.
- The repo URL is untrusted input. Reject anything that is not `https://`. Use `execFile` with an argument array — never `exec` with an interpolated command string.

---

### Task 1: Key validation and repo cloning

**Files:**
- Create: `src/server/create.ts`
- Create: `tests/server/create.test.ts`
- Modify: `src/server/index.ts` — use these validators inside `POST /api/rooms`.

**Interfaces:**
- Consumes: `node:child_process`, `node:fs`, `node:path`.
- Produces:
  - `validateApiKeyShape(value: unknown): { ok: true } | { ok: false; message: string }`
  - `validateRepoUrl(value: unknown): { ok: true; url: string | null } | { ok: false; message: string }`
  - `prepareWorkspace(roomId: string, repoUrl: string | null, baseDir?: string): Promise<string>` — returns the room's `cwd`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/create.test.ts
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareWorkspace, validateApiKeyShape, validateRepoUrl } from '../../src/server/create.js';

describe('validateApiKeyShape', () => {
  it('accepts a console key', () => {
    expect(validateApiKeyShape('sk-ant-api03-TESTONLY-not-a-real-key')).toEqual({ ok: true });
  });

  it('rejects anything else without echoing what was sent', () => {
    const result = validateApiKeyShape('hunter2');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).not.toContain('hunter2');
  });

  it('rejects a non-string', () => {
    expect(validateApiKeyShape(undefined).ok).toBe(false);
    expect(validateApiKeyShape(12345).ok).toBe(false);
  });
});

describe('validateRepoUrl', () => {
  it('accepts an https url and treats empty as none', () => {
    expect(validateRepoUrl('https://github.com/example/repo.git')).toEqual({
      ok: true,
      url: 'https://github.com/example/repo.git',
    });
    expect(validateRepoUrl('')).toEqual({ ok: true, url: null });
    expect(validateRepoUrl(undefined)).toEqual({ ok: true, url: null });
  });

  it('rejects non-https schemes and shell metacharacters', () => {
    expect(validateRepoUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateRepoUrl('git@github.com:example/repo.git').ok).toBe(false);
    expect(validateRepoUrl('https://x.com/a.git; rm -rf /').ok).toBe(false);
  });
});

describe('prepareWorkspace', () => {
  it('creates an isolated per-room directory when no repo is given', async () => {
    const base = mkdtempSync(join(tmpdir(), 'nexus-work-'));
    const cwd = await prepareWorkspace('room_a', null, base);
    expect(cwd).toContain('room_a');
    expect(existsSync(cwd)).toBe(true);
  });

  it('rejects a room id that would escape the base directory', async () => {
    const base = mkdtempSync(join(tmpdir(), 'nexus-work-'));
    await expect(prepareWorkspace('../../etc', null, base)).rejects.toThrow(/unsafe room id/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server/create.test.ts`
Expected: FAIL — cannot resolve `../../src/server/create.js`.

- [ ] **Step 3: Write `src/server/create.ts`**

```typescript
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DEFAULT_WORKDIR = process.env['NEXUS_WORKDIR'] ?? './work';
const SAFE_ROOM_ID = /^[A-Za-z0-9_-]+$/;
// Deliberately narrow: https only, no shell metacharacters, no credentials.
const SAFE_REPO_URL = /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;

export function validateApiKeyShape(value: unknown): { ok: true } | { ok: false; message: string } {
  if (typeof value !== 'string' || !value.startsWith('sk-ant-')) {
    // Never echo the received value — it may be a real credential.
    return {
      ok: false,
      message:
        'Nexus needs an Anthropic Console API key beginning with "sk-ant-". Subscription logins (Free, Pro, Max) cannot be used by third-party tools.',
    };
  }
  return { ok: true };
}

export function validateRepoUrl(
  value: unknown,
): { ok: true; url: string | null } | { ok: false; message: string } {
  if (value === undefined || value === null || value === '') return { ok: true, url: null };
  if (typeof value !== 'string' || !SAFE_REPO_URL.test(value)) {
    return { ok: false, message: 'Repository URL must be a plain https:// address.' };
  }
  return { ok: true, url: value };
}

/** One working directory per room. Never the server's own checkout. */
export async function prepareWorkspace(
  roomId: string,
  repoUrl: string | null,
  baseDir: string = DEFAULT_WORKDIR,
): Promise<string> {
  if (!SAFE_ROOM_ID.test(roomId)) {
    throw new Error(`unsafe room id: ${JSON.stringify(roomId)}`);
  }
  const cwd = join(resolve(baseDir), roomId);
  mkdirSync(cwd, { recursive: true });

  if (repoUrl !== null) {
    // execFile with an argument array — never a shell string.
    await run('git', ['clone', '--depth', '1', repoUrl, cwd], { timeout: 120_000 });
  }

  return cwd;
}
```

- [ ] **Step 4: Use it in `POST /api/rooms`**

Replace the inline key check with:

```typescript
    const keyCheck = validateApiKeyShape(body?.apiKey);
    if (!keyCheck.ok) return c.json({ error: keyCheck.message }, 400);

    const repoCheck = validateRepoUrl(body?.repoUrl);
    if (!repoCheck.ok) return c.json({ error: repoCheck.message }, 400);
```

Then, after `createRoom(...)` returns a room, prepare its workspace:

```typescript
    try {
      await prepareWorkspace(room.id, repoCheck.url);
    } catch {
      // Never surface the raw git error — it can echo the URL and credentials.
      return c.json(
        { error: 'Could not clone that repository. Check the URL and try again.' },
        400,
      );
    }
```

`Room.cwd` is readonly and `src/server/rooms.ts` is owned by `phase-0-spine`.
If threading the prepared path into the room requires changing that file's
signature, report BLOCKED with the exact one-line diff instead of editing it.

- [ ] **Step 5: Run tests and commit**

Run: `npm test`
Expected: all pass.

```bash
git add src/server/create.ts src/server/index.ts tests/server/create.test.ts
git commit -m "feat(create): validated BYOK entry and sandboxed per-room repo clone"
```

---

### Task 2: Creation page

**Files:**
- Create: `client/src/pages/CreateRoom.tsx`
- Create: `client/tests/create-room.test.tsx`
- Modify: `client/src/App.tsx` — render `CreateRoom` when there is no `room` query param.

**Interfaces:**
- Consumes: `fetch`.
- Produces: `CreateRoom({ onCreated })` where `onCreated(link: string)`.

- [ ] **Step 1: Write the failing test**

Tests 2 and 3 are the client-side I4 regression tests.

```tsx
// client/tests/create-room.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CreateRoom } from '../src/pages/CreateRoom.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

describe('CreateRoom', () => {
  it('states the security model on the page', () => {
    render(<CreateRoom onCreated={vi.fn()} />);
    expect(screen.getByText(/shared security boundary/i)).toBeInTheDocument();
    expect(screen.getByText(/people you trust/i)).toBeInTheDocument();
  });

  it('posts the key in the body and returns a link with no key in it', async () => {
    const onCreated = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ roomId: 'room_a', token: 't'.repeat(64) }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CreateRoom onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: /create room/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/rooms');
    expect(String(init.body)).toContain(KEY);
    expect(url).not.toContain('sk-ant');
    expect(String(onCreated.mock.calls[0]?.[0])).not.toContain('sk-ant');

    vi.unstubAllGlobals();
  });

  it('never writes the key to browser storage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ roomId: 'r', token: 't' }) }),
    );
    render(<CreateRoom onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: /create room/i }));
    await waitFor(() => expect(JSON.stringify(localStorage)).not.toContain('sk-ant'));
    expect(JSON.stringify(sessionStorage)).not.toContain('sk-ant');
    vi.unstubAllGlobals();
  });

  it('shows a sentence, not a stack trace, when creation fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, json: async () => ({ error: 'That key looks wrong.' }) }),
    );
    render(<CreateRoom onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /create room/i }));
    await waitFor(() => expect(screen.getByText('That key looks wrong.')).toBeInTheDocument());
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix client test -- tests/create-room.test.tsx`
Expected: FAIL — cannot resolve `../src/pages/CreateRoom.js`.

- [ ] **Step 3: Write `client/src/pages/CreateRoom.tsx`**

```tsx
import { useState } from 'react';
import type { FormEvent } from 'react';

export function CreateRoom({ onCreated }: { onCreated: (link: string) => void }): JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // The key goes in the body, over HTTPS, once. Never in a URL, never in
      // localStorage, never held after this call returns.
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey, repoUrl }),
      });
      const payload = (await response.json()) as { roomId?: string; token?: string; error?: string };
      if (!response.ok) {
        setError(payload.error ?? 'Could not create the room. Try again.');
        return;
      }
      setApiKey('');
      onCreated(
        `${globalThis.location.origin}/?room=${payload.roomId ?? ''}&token=${payload.token ?? ''}`,
      );
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="mb-2 text-2xl font-semibold">Open a Nexus room</h1>
      <p className="mb-6 text-sm text-slate-600">
        One agent, one context window, everyone in the room watching the same thing.
      </p>

      <div className="mb-6 rounded border-2 border-amber-400 bg-amber-50 p-4 text-sm">
        <p className="mb-2 font-semibold text-amber-900">
          A shared room is a shared security boundary.
        </p>
        <p className="text-amber-900">
          Whatever the room can do, every participant can do — read <code>.env</code>, use your git
          credentials, run commands. Only share this link with people you trust. Rooms are not
          isolated from each other in this preview.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span>Anthropic Console API key</span>
          <input
            type="password"
            value={apiKey}
            autoComplete="off"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk-ant-…"
            className="rounded border border-slate-300 px-3 py-2 font-mono text-sm"
          />
          <span className="text-xs text-slate-500">
            Console keys only. Claude Free, Pro, and Max logins cannot be used by third-party tools.
            The key stays on the server and is never written to the event log.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span>Git repository to clone (optional)</span>
          <input
            type="url"
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            placeholder="https://github.com/you/project.git"
            className="rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </label>

        {error !== null && (
          <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-40"
        >
          {busy ? 'Creating…' : 'Create room'}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 4: Route to it from `client/src/App.tsx`**

Replace the existing no-room placeholder branch with:

```tsx
  if (params.roomId === '' || params.token === '') {
    return <CreateRoom onCreated={(link) => globalThis.location.assign(link)} />;
  }
```

- [ ] **Step 5: Run tests and commit**

Run: `npm --prefix client test`
Expected: all pass. The `phase-1b` smoke test asserting the text `Nexus` may now
fail — if so, update **that assertion only** to match the new landing copy, and
say so in your report.

```bash
git add client/src/pages/CreateRoom.tsx client/src/App.tsx client/tests/create-room.test.tsx
git commit -m "feat(client): room creation page with BYOK entry and stated security model"
```

---

## Report notes

- Confirm the key appears only in the POST body: not in any URL, not in `localStorage`/`sessionStorage`, not in any error string.
- Whether threading the prepared workspace path into `Room.cwd` needed a change to `src/server/rooms.ts`, and the exact diff if so.
- Any `phase-1b` test assertion you had to update, and why.
