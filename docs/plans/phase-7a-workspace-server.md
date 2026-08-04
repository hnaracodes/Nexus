# Phase 7a — Server: workspace API, watcher, git status, model, telemetry

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the room a jailed, read-only view of its own working directory over REST; push a debounced change signal to attached clients; expose git status and diff; let the driver switch models without restarting the agent; and log real context-window telemetry.

**Why:** `client/src/components/ToolCallRow.tsx` renders `{"file_path": "...", "old_string": "..."}` as raw JSON in a `<pre>`, and that is the entire visual representation of the agent changing your repository. 7b turns that into a file tree and a rendered diff — but it cannot, because there is no server endpoint that will hand it a file. This plan is that endpoint, plus the three smaller server-side capabilities the workspace UI needs around it.

**Architecture:** Three new self-contained modules with injected seams (`workspace.ts`, `watcher.ts`, `gitStatus.ts`), five REST routes guarded exactly like `GET /api/rooms/:id`, one new `ClientFrame`, one new transient `ServerFrame`, and two new **logged** events. File contents are served over REST and are deliberately *not* log-derived — see Global Constraints.

**Mode:** PARALLEL with `phase-7c-prompt-dock.md`. `phase-7b-workspace-pane.md` consumes this plan's protocol changes and must merge after it.

**Files owned:**
- `src/server/workspace.ts` (new)
- `src/server/watcher.ts` (new)
- `src/server/gitStatus.ts` (new)
- `src/protocol/events.ts`
- `src/protocol/wire.ts`
- `src/server/agent.ts`
- `src/server/ws.ts`
- `src/server/publish.ts` — **`export` keyword additions only**, no logic changes
- `src/server/index.ts` — **only inside the two `phase-7` marker regions** (`phase-7 workspace routes` and `phase-7 set_model branch`) and the `// phase-7 import anchor` line
- `tests/server/workspace.test.ts`, `tests/server/watcher.test.ts`, `tests/server/gitStatus.test.ts` (new)
- phase-7 additions to `tests/server/{ws,agent,hardening}.test.ts` and `tests/protocol/events.test.ts`

Anything outside these globs: stop and report `BLOCKED`. In particular all of `client/**` belongs to 7b and 7c.

---

## Global Constraints

- `npm test`, `npm run typecheck` must exit 0 before any commit. You do not own client code, so `npm run test:client` should be unchanged — if it breaks, you edited something you do not own.
- **I3 — and the new boundary this plan draws.** File contents and the file tree are read from `room.cwd` and are **not** reconstructible from the event log. This is the first client-visible state in the project that is not log-derived, and it is deliberate: a file's bytes are not room history. They are served over REST. What *is* room history — who switched the model, what the context usage was — becomes a logged event. **Do not** put file contents into an event, into `RoomView`, or into the broadcast.
- **`workspace_changed` is transient and unlogged.** A raw filesystem-change stream is not room history; logging it would bloat every room's JSONL with `node_modules` churn and tell a replaying client nothing it cannot re-fetch.
- **Widening `src/protocol/events.ts` is TWO edits, not one.** A new member must join the `NexusEvent` union **and** the runtime `LOGGED_TYPES` set (`events.ts:228`). A type in the union but missing from the set is written to the JSONL happily and then **silently dropped when the log is read back** — an I3 violation no in-memory test catches. This bit the phase-4 session; the file's own comment at `events.ts:244-247` warns about it.
- **I1 — one room, one agent.** `setModel` mutates the existing session; it must never call `query()` again. Likewise the watcher lives inside the memoized `attachRoom` gate so a room cannot accumulate N watchers.
- **I2′ — enforcement is server-side.** `set_model` is rejected at the server for a non-driver *when a driver exists*, and open when the floor is open. Disabling the control in the UI is decoration.
- **I4 — untouched, and keep it that way.** Do not add anything to an error path that could carry a token. `redactEvent` runs over the new events for free via `commit()`.
- **Security framing, so nobody later reads this as a regression:** a read-only file API does **not** widen the room's security boundary. `Read` is already in `permissions.ts`'s `AUTO_APPROVE` set, so any participant can already obtain any file's contents by asking the agent, with no vote. This removes a round-trip; it grants no new reach. What it *does* add is a **new path-traversal surface**, which is why the jail is `realpathSync`-based and not lexical.

---

### Task 1: Protocol — frames and the two logged events

**Files:** `src/protocol/wire.ts`, `src/protocol/events.ts`, `tests/protocol/events.test.ts`

The whole event union was frozen up front by `phase-0-spine` precisely so feature branches would not collide here. This task is the one deliberate widening for phase 7, and it lands **first and alone** so 7b and 7c can code against it.

- [ ] **Step 1: Write the failing tests**

  In `tests/protocol/events.test.ts`, add an `isLoggedEvent` case for **each** new type — this is a regression test for the two-edit trap itself, not a formality:

  ```ts
  it('treats model_changed as a logged event', () => {
    expect(isLoggedEvent({ seq: 1, ts: 'x', roomId: 'r', type: 'model_changed' })).toBe(true);
  });
  it('treats context_usage as a logged event', () => {
    expect(isLoggedEvent({ seq: 1, ts: 'x', roomId: 'r', type: 'context_usage' })).toBe(true);
  });
  ```

  Add `parseClientFrame` cases covering: `{kind:'set_model', model:'claude-sonnet-5'}` → parsed; `{kind:'set_model', model:null}` → parsed with `model: null`; `{kind:'set_model'}` (absent) → `null`; `{kind:'set_model', model: 5}` → `null`.

- [ ] **Step 2: Run tests to verify they fail**

  `npm test -- events` — the `isLoggedEvent` cases must fail, proving the type is genuinely absent rather than accidentally passing.

- [ ] **Step 3: Widen `src/protocol/events.ts`**

  Two interfaces, added to the union **and** to `LOGGED_TYPES`:

  ```ts
  export interface ModelChanged extends EventEnvelope {
    type: 'model_changed';
    participantId: string;
    displayName: string;
    /** null means "the account default" — see setModel(model?) in the SDK. */
    model: string | null;
  }

  export interface ContextUsage extends EventEnvelope {
    type: 'context_usage';
    /** Null on a compact_boundary, which carries no model field. */
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    contextWindow: number;
    /** Set only by a compact_boundary: tokens in play before compaction. */
    compactedFromTokens: number | null;
  }
  ```

  Field names mirror the SDK's own `ModelUsage` (`coreTypes.d.ts:8-16`) so `translate()` is a near-identity copy rather than a renaming exercise that can silently drop precision.

  **Deliberately not mirrored:** `ModelUsage` also carries `webSearchRequests` and `costUSD`. Both are omitted. Logging per-turn dollar cost makes room spend part of the permanent, shareable transcript, and that is a product decision nobody has taken — do not add it because the field was there.

- [ ] **Step 4: Widen `src/protocol/wire.ts`**

  Add to `ServerFrame`:

  ```ts
  | { kind: 'workspace_changed'; paths: string[]; truncated: boolean }
  ```

  Add to `ClientFrame`:

  ```ts
  | { kind: 'set_model'; model: string | null }
  ```

  And the `parseClientFrame` case, matching the file's existing strict-validation style:

  ```ts
  case 'set_model':
    return typeof frame['model'] === 'string' || frame['model'] === null
      ? { kind: 'set_model', model: frame['model'] as string | null }
      : null;
  ```

  **`null`, not `undefined`, and this is load-bearing.** `undefined` does not survive `JSON.stringify`, so an "use the default model" frame sent as `undefined` arrives as an absent key and is indistinguishable from a malformed frame. `null` transmits. The SDK's `setModel(model?: string)` wants `undefined` for default — Task 5 bridges the two.

- [ ] **Step 5: Run tests and commit**

  `npm test -- events`, then `npm test && npm run typecheck`. Commit as `feat(protocol): phase-7 workspace frames and model/context events`.

---

### Task 2: `src/server/workspace.ts` — the jailed read layer

**Files:** `src/server/workspace.ts` (new), `tests/server/workspace.test.ts` (new)

This is the highest-risk file in the phase. Everything else is a feature; this one is a security boundary.

- [ ] **Step 1: Write the failing tests**

  Use **real temp dirs and a real escaping symlink** (`fs.symlinkSync`, as `tests/server/create.test.ts` already does) — a mocked filesystem cannot demonstrate the bug this jail exists to prevent. Assert rejection of:
  - `../` traversal, and a URL-encoded variant
  - a **symlink inside the workspace pointing outside it** (the case lexical checks miss entirely)
  - a differently-cased spelling of the root prefix
  - a path containing `\0`
  - a non-existent path → **404, not 500**

  Assert `.git` and `node_modules` never appear in a listing; that the size cap trips; and binary detection against a PNG-header fixture.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Write `resolveWorkspacePath(room, requestedPath): string`**

  `path.resolve()` collapses `..` lexically but **never touches the filesystem**, so a hostile cloned repo can commit a symlink that escapes `room.cwd` and a lexical check will not see it. Use `realpathSync` on **both** the candidate and the root — comparing a realpath'd child against a non-realpath'd root is the same bug family as having no jail at all. Case-fold before the prefix compare: `resolve()` does not normalize case and macOS/Windows filesystems are case-insensitive. Reject embedded `\0` before touching the filesystem. A non-existent path must be reported distinguishably so the route can 404 rather than 500.

- [ ] **Step 4: Write `listTree(room, path): TreeEntry[]`**

  **One level, not recursive** — the client recurses lazily, which keeps a `node_modules` in the tree from becoming an unbounded response. Re-jail every symlinked child; a directory entry that resolves outside the root is omitted, not followed.

  Deny-list `.git` and `node_modules`. **Do not honor `.gitignore`.** It is a content file inside the untrusted tree, and correct gitignore semantics — nesting, `!` negation, global excludes — is a subproject, not a line of code.

- [ ] **Step 5: Write `readWorkspaceFile(room, path): FileReadResult`**

  A discriminated union: `text | binary | too_large`. 1 MiB cap. Binary detection by null-byte sniff in the first 8 KB (git's own heuristic). Non-UTF8 text decoded **with replacement** rather than throwing — a viewer that renders mojibake is better than one that 500s on a Latin-1 file.

- [ ] **Step 6: Run tests and commit**

---

### Task 3: `src/server/watcher.ts` — debounced change signal

**Files:** `src/server/watcher.ts` (new), `tests/server/watcher.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

  Inject a fake `watch()`. Assert: debounce coalescing; the 200-path cap setting `truncated: true` **while still delivering the paths that fit**; a **throwing** `fs.watch` degrading to a no-op watcher rather than propagating; and that `.git`/`node_modules` are filtered before reaching `onChange`.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Write `startWorkspaceWatcher(room, onChange)`**

  **Request `recursive: true` unconditionally inside a `try`/`catch`. Never behind a `process.platform` check.** Node 22 supports recursive watch on Linux; a platform gate would silently degrade the Debian container to top-level-only watching — invisible in production, perfect on a macOS or Windows dev box. That is precisely the shape of `CLAUDE.md`'s port-8080 gotcha. A catch-and-fall-back is correct regardless of where the Node version boundary actually sits.

  300 ms debounce. Cap at 200 paths per frame; on overflow ship `truncated: true` **alongside whatever paths fit** — never a silent drop (`CLAUDE.md`: "no silent caps"). Contract with the client: on `truncated`, `paths` is informational and the client refetches the tree.

  A synchronous `fs.watch` throw must degrade to a no-op watcher, **not** crash room attachment. Pull-based browsing still works; live update is a nicety, and a room that will not attach is not.

- [ ] **Step 4: Run tests and commit**

---

### Task 4: `src/server/gitStatus.ts` — status and diff

**Files:** `src/server/gitStatus.ts` (new), `src/server/publish.ts` (export additions only), `tests/server/gitStatus.test.ts` (new)

- [ ] **Step 1: Export the runner seam from `publish.ts`**

  **Verified against the real file:** `GitRunner` is *already* exported (`publish.ts:60`). Only `defaultGit` (`:172`) and `runGit` (`:196`) are module-private. Add `export` to those two and change nothing else in that file. *(The design plan said all three were private. It was wrong about `GitRunner`.)*

  Do **not** build a second `execFile` wrapper. A new module rather than adding to `publish.ts`, because that file's header comment is specifically about the credential-safety story of the *push* path; local status and diff carry no credential and mixing them muddies a security-relevant comment.

- [ ] **Step 2: Write the failing tests**

  Inject a `GitRunner` — the same shape `tests/server/publish.test.ts` already uses — with canned porcelain output, **including a filename containing a quote, a backslash and a space.**

- [ ] **Step 3: Run tests to verify they fail**

- [ ] **Step 4: Write `getGitStatus` and `getGitDiff`**

  Use `status --porcelain=v1 -z`. NUL-terminated, because porcelain has the same C-quoting hazard that `publish.ts` already handles with `-z` for `ls-tree` — and phase 6 shipped a real bug here (`core.quotePath=false` does *not* stop C-style quoting; it only suppresses escaping of bytes above 0x80).

  Put `--` before any room-supplied path so it can never be read as a git option.

  **No `git log`, no `origin/<branch>` comparison.** Clones are `--depth 1` (both paths in `create.ts`), which makes both unreliable, and fetching would reopen the SSRF surface `create.ts` exists to control. The diff baseline is working-tree vs. clone-time HEAD — the same framing `publish.ts` already settled on for `baseCommitSha`.

- [ ] **Step 5: Run tests and commit**

---

### Task 5: `src/server/agent.ts` — model control and context telemetry

**Files:** `src/server/agent.ts`, `tests/server/agent.test.ts`

- [ ] **Step 1: Write the failing tests**

  `translate()` is a pure exported function taking `unknown` — test it directly with synthetic messages, no SDK subprocess. Assert:
  - a `result` message with `modelUsage` emits `agent_idle` **and** one `context_usage` per model key
  - a `result` message with **no** `modelUsage` still emits `agent_idle` alone (guards against a future SDK narrowing)
  - a `{type:'system', subtype:'compact_boundary', compact_metadata:{trigger, pre_tokens}}` emits a `context_usage` carrying `compactedFromTokens`
  - `setModel(null)` calls the session's `setModel` with `undefined`

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Widen `AgentHandle`**

  ```ts
  setModel(model: string | null): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  ```

  Both close over `session`, which today is a `startAgent`-local `const` at `agent.ts:150`, retained nowhere — not on `AgentHandle`, not on `Room`. **Verified against the real SDK types** (`entrypoints/sdk/runtimeTypes.d.ts`):

  ```ts
  setModel(model?: string): Promise<void>;   // :111, "Only available in streaming input mode"
  supportedModels(): Promise<ModelInfo[]>;   // :135
  ```

  Nexus is in streaming input mode (it feeds an async-iterable prompt), so it qualifies. **The parameter is `string | undefined`, not `string | null`** — bridge it explicitly:

  ```ts
  async setModel(model: string | null): Promise<void> {
    await session.setModel(model ?? undefined);
  }
  ```

  Passing `null` straight through is a type error. This preserves I1: `setModel` mutates the running session and never calls `query()` a second time.

- [ ] **Step 4: Extend `translate()`**

  In the existing `result` branch (`agent.ts:285-287`, currently a lone `agent_idle` push), also emit `context_usage` from `modelUsage`, one per model key, **alongside** the existing `agent_idle`. Add a new `system`/`compact_boundary` branch.

  **Flooding check, already done:** `result` fires exactly once per turn — the same cardinality as today's `agent_idle` — and `compact_boundary` is rarer. Neither is per-delta. Verified: `modelUsage` is present on **both** result subtypes (`coreTypes.d.ts:451` success, `:467` error), so the branch's existing `m['type'] === 'result'` test covers both.

  Every read goes through a runtime guard. `translate` takes `unknown` and must never throw.

- [ ] **Step 5: Run tests and commit**

---

### Task 6: Routes, the `set_model` branch, and watcher lifecycle

**Files:** `src/server/index.ts` (marker regions only), `src/server/ws.ts`, `tests/server/{ws,hardening}.test.ts`

> **Seam correction — read this before you start.** The design plan said to add the `set_model` message branch to `src/server/ws.ts`. **That is wrong.** `ws.on('message')` and the entire `parseClientFrame` switch live in **`src/server/index.ts:422`**; `ws.ts` has no message handling at all — it owns `RoomRuntime`, `attachRoom` and identity. The branch goes in `index.ts` inside the `phase-7 set_model branch` marker region. `ws.ts` gets only the watcher lifecycle.

- [ ] **Step 1: Write the failing tests**

  In `tests/server/ws.test.ts`: a driver's `set_model` is accepted; a **non-driver's is rejected with an `error` frame while a driver exists**; with the floor open (`room.driverId === null`) anyone's is accepted. This mirrors `request_control`'s existing floor-open semantics rather than inventing a third policy.

  In `tests/server/hardening.test.ts`: an end-to-end `GET /api/rooms/:id/workspace/file?path=../../etc/passwd` returns **400 — not 200 and not 500** — and the same for a URL-encoded variant.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Add the five routes** inside the `phase-7 workspace routes` marker region of `index.ts`

  ```
  GET /api/rooms/:id/workspace/tree?path=
  GET /api/rooms/:id/workspace/file?path=
  GET /api/rooms/:id/git/status
  GET /api/rooms/:id/git/diff?path=
  GET /api/rooms/:id/models
  ```

  Guard each exactly as `GET /api/rooms/:id` does (`index.ts:288-296`) — `X-Nexus-Token` header plus `authorize()`, 404 for an unknown room, 401 for a bad token:

  ```ts
  const room = getRoom(c.req.param('id'));
  if (room === undefined) return c.json({ error: 'No such room.' }, 404);
  const token = c.req.header('X-Nexus-Token');
  if (token === undefined || authorize(room.id, token) === undefined) {
    return c.json({ error: 'Invalid room token.' }, 401);
  }
  ```

  **No query-param token fallback.** Only the WS upgrade needs one, because the browser's native `WebSocket` constructor cannot set headers; `fetch` can. The room token is the credential and it already appears in too many URLs.

  **The path is a query param, not a wildcard segment.** Hono decodes and normalizes wildcard segments before the handler sees them, and "someone else already parsed this" is not what you want on a jail boundary.

  `PAGE_ROUTES` is untouched — these are API routes, not client pages, and the deliberate property that an unmatched `/api/*` 404s rather than returning `index.html` must survive (`tests/server/static-routes.test.ts` guards it).

- [ ] **Step 4: Add the `set_model` branch** inside the `phase-7 set_model branch` region of `index.ts`

  Reject a non-driver with an `error` frame when `room.driverId !== null`, reusing `isDriver` (already imported at `index.ts:50`). Otherwise **fire-and-forget**, matching how the `interrupt` branch already handles a promise:

  ```ts
  void runtime.agent
    .setModel(frame.model)
    .then(() => { runtime.commit({ type: 'model_changed', participantId, displayName, model: frame.model }); })
    .catch(() => { runtime.commit({ type: 'agent_error', /* fixed message, never the raw error (I4) */ }); });
  ```

  **Do not make the `ws.on('message')` handler `async`.** Awaiting inside it would serialize that socket's message handling behind a model switch.

- [ ] **Step 5: Start the watcher in `attachRoom`** (`ws.ts:52`)

  After `startAgent`, inside the memoized gate — the `existing !== undefined` early return at `ws.ts:57-58` is what guarantees a room cannot accumulate N watchers, mirroring the one-agent discipline for a second resource. Broadcast `workspace_changed` from `onChange`.

  Store the handle on `RoomRuntime`. **There is no room-teardown path in this codebase** — `runtimes` only grows and `__resetRuntimes()` is test-only. Store it anyway so a future teardown has something to close; do **not** invent a teardown mechanism no other resource has.

- [ ] **Step 6: Run the full gate and commit**

  `npm test && npm run typecheck`. Report the test count — a green suite that did not grow means your tests were never discovered.

---

## Report notes

State plainly in your report:
- The exact test counts before and after.
- Whether the `hardening.test.ts` traversal case genuinely returns 400 rather than 500 — a 500 means the jail threw instead of refusing, which is a different (and worse) behaviour that still looks like "blocked" in a careless test.
- Anything you had to change outside your owned globs. If that happened, you should have reported `BLOCKED` instead.
