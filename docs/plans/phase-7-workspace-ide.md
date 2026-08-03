# Phase 7 — Workspace IDE

> **Status: design plan, NOT dispatch-ready.** This file does not yet carry
> `### Task N:` headings with checkbox steps, so `scripts/task-brief` cannot
> extract a task from it and `superpowers:subagent-driven-development` cannot
> consume it. It is the architecture and the decisions behind it. **Decompose it
> into numbered tasks, and compile every code fragment against the real
> signatures, before any dispatch** — `CLAUDE.md`: *a plan is not a specification
> until someone has tried to compile it.* Phase 3 shipped three plans containing
> literal code that could not work.
>
> A refinement pass on this plan was handed to Ultraplan
> (`claude.ai/code/session_0149PK2RrVi3A7KhfmMTSkr6`) and had not returned when
> this file was committed. Reconcile before decomposing.

## Context

Nexus today is a **chat transcript with a governance layer**. You prompt an agent, watch tool calls scroll by as collapsible JSON cards, and vote on whether it may run `Edit`. What you cannot do is *see the code*. There is no file tree, no file viewer, no diff — `ToolCallRow.tsx` renders `{"file_path": "...", "old_string": "..."}` as raw JSON in a `<pre>`, and that is the entire visual representation of the agent changing your repository.

This is a real product gap and the project's own docs have flagged it since day one. `project_goal.md` §4.2 lists a "Yjs-bound file/diff panel" as one of four intended client surfaces; §7's original Phase 3 says a file tree with live diffs is *"where it stops looking like a terminal and starts looking like a product."* `BUILD_SPEC.md` §2 deferred it for the 5-day MVP and it was never scheduled since.

The intended outcome: a room looks and feels like Cursor. Chat on the left with a model selector, voice input, branch/repo status and a context-window bar. A tabbed workspace on the right with a file tree, syntax-highlighted code viewer, and live rendered diffs of what the agent is doing.

**The governance payoff is the part that isn't in the original ask.** `Edit` and `Write` are not in `permissions.ts`'s `AUTO_APPROVE` set, so every file edit already fires a `permission_requested` event carrying `{file_path, old_string, new_string}` *before the write happens*. Rendering that as a diff instead of raw JSON means the four-eyes gate stops being "approve this JSON blob" and becomes "approve this diff." That is `CLAUDE.md`'s stated thesis — *collaboration is the mechanism, governance is the product* — and today it's the weakest-looking surface in the app.

### Scope decisions taken during design

| Decision | Choice |
|---|---|
| Slice | Layout shell + read-only workspace API + live edits + all four chat-chrome items. **Browser-preview pane is out of scope** (tab stub only). |
| Multi-user file selection | Per-person local UI state, with **auto-follow the agent's current file** on by default and a pin toggle. No new room state, no arbitration. |
| Editing | Read-only, plus "edit via prompt": selecting a range adds it as context to the prompt box (Cursor's ⌘L). |
| Freshness | Server `fs.watch` → debounced transient `workspace_changed` frame. |
| Dependencies | **Shiki 4.4.1** only (client goes 3 → 4 runtime deps). Line diff hand-rolled. |
| Approvals | Compact card stays in chat; clicking opens the **rendered diff** in the workspace pane. |

### Verified facts that shaped the design

Checked against the real tree, not assumed:

- `query.setModel(model?)` / `supportedModels()` exist (`runtimeTypes.d.ts:111,135`), documented streaming-input-mode-only — Nexus qualifies, so **the model switches without restarting the agent**, preserving I1.
- `ModelUsage.contextWindow` (`coreTypes.d.ts:15`) and `SDKCompactBoundaryMessage.compact_metadata.pre_tokens` give a real context bar with a real compaction marker.
- `git` is in the runtime image (`Dockerfile:37-40`, added for phase-3c cloning). No image change needed.
- Node 22 is pinned in `package.json` engines and all three Dockerfile stages.
- `assistant_delta` is **declared in `wire.ts` but never actually emitted by the server** — `translate()` has no `stream_event` branch. It is a shape precedent, not a working example. `workspace_changed` will be the first transient frame wired end to end.
- `ToolStart.input` / `PermissionRequested.input` are typed `unknown`. Every read of `file_path`/`old_string`/`content` needs a **runtime type guard**, matching `ToolSummary.ts`'s existing never-throws style. Not a cast.
- Clones are `--depth 1` (both paths in `create.ts`). Diff baseline is working-tree vs. clone-time HEAD — the same framing `publish.ts` already settled on for `baseCommitSha`.
- `client/src/components/AgentActivity.tsx` **exists**. A comment in `RoomHeader.tsx` describing it as an unresolved fan-out import is stale.

---

## Invariant compliance

| | Status |
|---|---|
| **I1** — one room, one agent | Preserved. `setModel` mutates the existing session; it never calls `query()` again. The fs watcher lives inside the memoized `attachRoom` gate so a room cannot accumulate N watchers, mirroring the one-agent discipline for a second resource. |
| **I2′** — server-side attribution/arbitration | `set_model` is driver-gated **when a driver exists**, open when the floor is open — reusing `isDriver()` and matching `request_control`'s existing floor-open semantics rather than inventing a third policy. Rejected server-side, not by disabling a control in the UI. |
| **I3** — log is authoritative | **This is where the design consciously draws a new boundary; it must be stated, not hidden.** File contents and the tree are read from `room.cwd` and are *not* reconstructible from the log. They are served over REST and cached in a hook that never touches `store.ts`. `RoomView` gains **zero** new fields. Everything that *is* room history — who switched the model, token usage, which files were touched — becomes a logged event. Enforcement is greppable: `client/src/workspace/*` must have no import of `store.ts`. |
| **I4** — keys never leak | Untouched. Token counts and model ids aren't secrets; `redactEvent` still runs over the new events for free via `commit()`. |

**Security note, so nobody later reads it as a regression:** a read-only file API does not widen the room's security boundary. `Read` is already in `AUTO_APPROVE`, so any participant can already obtain any file's contents through the agent with no vote. The API removes a round-trip; it does not grant new reach. What it *does* add is a new path-traversal surface, which is why the jail below is `realpathSync`-based rather than lexical.

---

## Build order

Three sub-plans. **7a and 7c are independent and can run in parallel; 7b depends on 7a's protocol changes only** (its components mock `fetch` and can be built against the contract before the server lands).

```
7a server  ──┬──> 7b client workspace pane ──> integration (App.tsx, single owner)
7c chrome  ──┘
```

Per `CLAUDE.md`, load the **`nexus-fanout-dispatch`** skill before writing dispatch prompts — audit the seams and compile the plan code first. The contended file is `client/src/App.tsx`; put paired marker comments (`{/* --- BEGIN phase-7 workspace slot --- */}` … `END`) in on the default branch **before** dispatching, and give integration a single owner, last.

---

## 7a — Server: workspace API, watcher, git status, model, telemetry

**Files owned:**
`src/server/workspace.ts` (new), `src/server/watcher.ts` (new), `src/server/gitStatus.ts` (new), `src/protocol/{events,wire}.ts`, `src/server/agent.ts`, `src/server/ws.ts`, the phase-7 route block of `src/server/index.ts`, `export` additions in `src/server/publish.ts`, `tests/server/{workspace,watcher,gitStatus}.test.ts`, phase-7 additions to `tests/server/{ws,agent,hardening}.test.ts` and `tests/protocol/events.test.ts`.

### New files

**`src/server/workspace.ts`** — the jailed read layer.

- `resolveWorkspacePath(room, requestedPath): string` — the jail. `resolve()` collapses `..` lexically but **never touches the filesystem**, so a hostile cloned repo can commit a symlink escaping `room.cwd` and lexical checks miss it entirely. Use `realpathSync` on both the candidate *and* the root (comparing a realpath'd child against a non-realpath'd root is the same bug family as no jail at all). Case-fold before the prefix compare — Windows paths are case-insensitive at the FS layer and `resolve()` does not normalize case. Reject embedded `\0`. Non-existent paths must 404, not 500.
- `listTree(room, path): TreeEntry[]` — one level, not recursive; the client recurses lazily. Re-jail every symlinked child. Deny-list `.git` and `node_modules`. **Do not honor `.gitignore`** — it is a content file inside the untrusted tree, and correct gitignore semantics (nesting, `!` negation, global excludes) is a subproject, not a line of code.
- `readWorkspaceFile(room, path): FileReadResult` — 1 MiB cap, binary detection via null-byte sniff in the first 8KB (git's own heuristic), non-UTF8 text decoded with replacement rather than erroring. Returns a discriminated union: `text | binary | too_large`.

**`src/server/watcher.ts`** — `startWorkspaceWatcher(room, onChange)`.

- **Request `recursive: true` unconditionally inside a `try`/`catch`, never behind a `process.platform` check.** Node 22 supports recursive watch on Linux; a platform gate would silently degrade the Debian container to top-level-only watching — invisible in production, perfect on the Windows dev box, and precisely the shape of `CLAUDE.md`'s port-8080 gotcha. A catch-and-fall-back is correct regardless of where the Node version boundary actually sits.
- 300ms debounce; filter `.git`/`node_modules` before they reach `onChange`.
- Cap at 200 paths per frame. On overflow ship `truncated: true` **alongside whatever paths fit** — never a silent drop (`CLAUDE.md`'s "no silent caps"). Contract: on `truncated`, the client discards `paths` as informational and refetches the tree.
- A synchronous `fs.watch` throw must degrade to a no-op watcher, not crash room attachment — pull-based browsing still works; live update is a nicety.
- Lifecycle: started inside `attachRoom`, handle stored on `RoomRuntime`. **There is no room-teardown path in this codebase today** (`runtimes` only grows; `__resetRuntimes()` is test-only). Store the handle anyway so a future teardown has something to close; do not invent a teardown mechanism no other resource has.

**`src/server/gitStatus.ts`** — `getGitStatus`, `getGitDiff`.

Reuse `publish.ts`'s `GitRunner` seam — **do not build a second `execFile` wrapper.** Requires exporting `GitRunner`, `defaultGit`, `runGit` from `publish.ts` (currently module-private). New file rather than adding to `publish.ts`, because that file's header comment is specifically about the *credential-safety story of the push path*; local status/diff carries no credential and mixing them muddies it.

Use `status --porcelain=v1 -z` (NUL-terminated — porcelain has the same quoting hazard `publish.ts` already handles with `-z` for `ls-tree`). Put `--` before any room-supplied path so it can never become a git option. No `git log`, no `origin/<branch>` comparison — the shallow clone makes both unreliable, and fetching would reopen the SSRF surface `create.ts` exists to control.

### Modified files

**`src/protocol/wire.ts`** — add `ServerFrame` variant `{ kind: 'workspace_changed'; paths: string[]; truncated: boolean }` (transient, unlogged — a raw fs-change stream is not room history) and `ClientFrame` variant `{ kind: 'set_model'; model: string | null }` plus its `parseClientFrame` case. `null` not `undefined`: `undefined` does not survive `JSON.stringify`, and the SDK's `setModel(model?)` treats absent as "default," which `null` maps to cleanly.

**`src/protocol/events.ts`** — two new logged events. **Each is TWO edits: the `NexusEvent` union AND the `LOGGED_TYPES` set.** A member missing from `LOGGED_TYPES` is written to JSONL and then silently dropped on replay — this bit the phase-4 session and the file's own header comment warns about it.

- `ModelChanged { participantId, displayName, model: string | null }`
- `ContextUsage { model: string | null, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, contextWindow, compactedFromTokens: number | null }` — field names mirror the SDK's own `ModelUsage` so `translate()` is a near-identity copy, not a renaming exercise that can silently drop precision. `model` is nullable because `SDKCompactBoundaryMessage` carries no model field.

**`src/server/agent.ts`** — widen `AgentHandle` with `setModel(model: string | null): Promise<void>` and `listModels(): Promise<ModelInfo[]>`, both closing over `session` (today a `startAgent`-local variable retained nowhere — not on `AgentHandle`, not on `Room`). In `translate()`: emit `context_usage` from the `result` branch's `modelUsage` (one per model key, alongside the existing `agent_idle`), and add a new `system`/`compact_boundary` branch. **Flooding check:** `result` fires exactly once per turn — the same cardinality as today's `agent_idle` — and `compact_boundary` is rarer. Neither is per-delta. A `result` with no `modelUsage` must still emit `agent_idle` alone (guards against a future SDK narrowing).

**`src/server/ws.ts`** — start the watcher inside `attachRoom` (after `startAgent`), broadcasting `workspace_changed`. Add the `set_model` message branch: reject non-drivers with an `error` frame when `room.driverId !== null`; otherwise **fire-and-forget** `setModel().then(commit model_changed, commit agent_error)` — matching how the `interrupt` branch already handles a promise. Do not make the `ws.on('message')` handler `async`; awaiting would serialize that socket's message handling.

**`src/server/index.ts`** — five routes, registered with the other `/api/rooms/:id/*` handlers, before the `PAGE_ROUTES` block. `PAGE_ROUTES` itself is untouched — these are API routes, not client pages.

```
GET /api/rooms/:id/workspace/tree?path=
GET /api/rooms/:id/workspace/file?path=
GET /api/rooms/:id/git/status
GET /api/rooms/:id/git/diff?path=
GET /api/rooms/:id/models
```

All use the `X-Nexus-Token` header + `authorize()`, identical to `GET /api/rooms/:id`. **No query-param token fallback** — only the WS upgrade needs that, because the browser's native `WebSocket` constructor cannot set headers; `fetch` can. Path is a **query param, not a wildcard segment**: Hono decodes and normalizes wildcard segments before the handler sees them, and "someone else already parsed this" is not what you want on a jail boundary.

### Tests

- `workspace.test.ts` — real temp dirs with a real escaping symlink (`fs.symlinkSync`, as `create.test.ts` already does). Assert rejection of `../` traversal, the escaping symlink, a differently-cased spelling of the root prefix, and a `\0` path. Assert `.git`/`node_modules` never listed; caps trip; binary detection on a PNG-header fixture.
- `watcher.test.ts` — injected fake `watch()`; assert debounce coalescing, the 200-cap setting `truncated: true` *while still delivering the paths that fit*, a throwing `fs.watch` degrading to a no-op, and ignore-filtering.
- `gitStatus.test.ts` — injected `GitRunner` (same shape `publish.test.ts` already uses) with canned porcelain output, including a filename containing a quote, backslash and space.
- Extend `ws.test.ts` (driver / non-driver / open-floor `set_model`), `agent.test.ts` (`translate()` on synthetic `result` + `compact_boundary`), `hardening.test.ts` (end-to-end `?path=../../etc/passwd` → 400, not 200 and not 500).
- Extend `tests/protocol/events.test.ts` with an `isLoggedEvent` case for each new type — **a regression test for the two-edit trap itself.**

---

## 7b — Client: workspace pane

**Files owned:**
`client/src/derive/**` (new), `client/src/workspace/**` (new), `client/src/components/{WorkspacePane,FileTree,CodeViewer,DiffViewer,ChangesTab}.tsx` (new), deletion of `client/src/components/SideRail.tsx`, `client/package.json` (`shiki` only), the `phase-7 workspace slot` region of `client/src/App.tsx`, matching `__tests__` files.

### Layout

Replace `RoomShell`'s current `main` + `SideRail` split (`App.tsx:438`) with chat column (fixed, resizable) + `WorkspacePane` (`flex-1`), tabs `Files | Changes | Preview (stub)`.

**`SideRail` is deleted — rehome all three of its sections, drop nothing:**

- *Roster* — already rendered by `RoomHeader`; `SideRail`'s copy is duplicate. Nothing lost.
- *PendingPrompts* — moves inline above `PromptInput`. It is about what's *about to be sent*; it belongs next to the input.
- *Settled approval history* — the only real loss if deleted. Goes to the top of the **Changes** tab, reusing `deriveApprovals(events).settled` verbatim: same derivation, new renderer.
- The `lg:hidden` mobile bottom-sheet + `railBadgeCount` mechanism retires with it; see Responsive.

### New modules

```
client/src/derive/workspaceFiles.ts     deriveTouchedFiles, deriveCurrentFile, deriveFileEdits
client/src/derive/diff.ts               diffLines, diffEditFragment  (pure, no deps)
client/src/workspace/types.ts           FileNode, FileContent, WorkspaceError
client/src/workspace/workspaceApi.ts    fetch wrappers
client/src/workspace/useWorkspace.ts    the cache hook
client/src/workspace/highlighter.ts     Shiki singleton, lazy
client/src/components/WorkspacePane.tsx tabs; owns selection + follow/pin state
client/src/components/FileTree.tsx
client/src/components/CodeViewer.tsx
client/src/components/DiffViewer.tsx
client/src/components/ChangesTab.tsx
```

Derivations follow the `approvals.ts` model exactly: pure functions over `NexusEvent[]`, zero React, unit-tested against fixtures. `deriveCurrentFile` uses the same backward-scan-for-unresolved-tool shape `agentStatus.ts` already uses. **Every read of `input` goes through a type guard** — it is `unknown` on the wire.

### The non-log boundary (see I3 above)

`useWorkspace` owns a `Map<path, {content, status, error, fetchedAtSeq}>` in its own `useState`. It **never imports `store.ts`**; `RoomView` gains no fields. It receives `touchedFiles` (already derived from the log by `WorkspacePane`) so it can mark entries stale without itself knowing what a `NexusEvent` is.

- **Stale, not silently refetched.** When a newer edit lands for a cached path, mark `stale` and render a "content changed — refresh" affordance over the last-known content. Never a blank flash.
- **Reconnect** reuses the same staleness path rather than blind-refetching everything, so there is exactly one "is this file current" code path.
- Distinguish `loading` / `error` / `stale` / `ready` so the viewer never renders "still fetching" as "empty file".

### Diff rendering — the interesting part

Whole-file diff (`Write`, git diff) is straightforward LCS over two known texts.

The `Edit` case is not: **`old_string` is a fragment, not the file.** Diffing the fragment alone gives a floating hunk with no line numbers and no surrounding code — useless for review, which is exactly what the approval gate needs it for.

1. **Anchored:** if any version of the file is cached, locate `old_string` as a literal substring, compute its line span, and diff a windowed region — real line numbers, real context.
2. **Honest fallback:** if it occurs zero or multiple times (stale cache, or genuinely repeated text — `old_string` uniqueness is an SDK invariant, not one a possibly-stale client cache may assume), render a contextless fragment diff with `contextUnavailable: true` and a visible banner. **Never fabricate line numbers that look real.**

### Shiki

Bundle size is the whole risk — the root `shiki` barrel pulls every grammar. Import `shiki/core` + `shiki/engine/oniguruma`, load grammars via individual dynamic `import()`s (ts, tsx, js, jsx, json, md, bash, css, html, yaml, python); everything else falls back to plain `<pre>`. The highlighter is a module singleton created on **first Files-tab open**, so a room that never opens the workspace pays zero Shiki bytes.

Theme: build a Shiki theme object inline from `design/tokens.ts`'s `COLORS` rather than shipping a bundled theme — one source of colour truth, and `index.css` already documents the room as dark-only. **Verify the emitted chunk size in `client/dist/assets/` before merging; do not assume.**

### Accessibility

`ToolCallRow.tsx` already sets the rule in its own comment: colour never carries meaning alone. A red/green-only diff violates it directly. Every line gets a `+`/`-`/space **gutter glyph** (also the most familiar convention for this audience), tinted backgrounds are additive, and each hunk carries an `aria-label` with add/remove counts. The `contextUnavailable` state is a text banner, never a colour cue.

### Responsive

Below `lg` (1024px), the workspace column does not render; a "Workspace" button opens it as a `fixed inset-0` full-screen sheet — reusing the retired room-details sheet pattern, but full-screen rather than `70vh`, because a code viewer in a 70vh sheet is unusable.

---

## 7c — Client: prompt-dock chrome

**Files owned:**
`client/src/components/{PromptDock,ModelSelector,VoiceInputButton,RepoBranchBar,ContextWindowBar}.tsx` (all new), matching `__tests__` files, and the `phase-7 prompt dock` region of `client/src/App.tsx`.

Add `PromptDock.tsx` composing `PromptInput` + `StopButton` + four new components, rather than editing `PromptInput.tsx`'s internals — its controlled/uncontrolled contract and existing tests stay untouched. `RoomHeader.tsx` needs no changes; per the approved layout all chrome sits under the prompt box.

| Component | Source of truth |
|---|---|
| `ModelSelector.tsx` | `GET /api/rooms/:id/models` to populate; sends `{kind:'set_model'}`; current model derived from the last `model_changed` event. Disabled with an explanatory tooltip for non-drivers when a driver exists. |
| `ContextWindowBar.tsx` | Last `context_usage` event. Ratio = `(input + cacheRead + cacheCreation) / contextWindow`. Renders a compaction marker when `compactedFromTokens` is set. **If no `context_usage` has arrived yet, render "usage unavailable" — never a fabricated percentage.** |
| `RepoBranchBar.tsx` | `deriveGithubBinding(view.events)` (exists) for owner/repo; branch is `nexus/<roomId>` per `publish.ts`. Pure derivation, no new state. |
| `VoiceInputButton.tsx` | Web Speech API → `PromptInput.onChange`. No protocol change. Must render a graceful unsupported state when `window.SpeechRecognition` is absent — and that is the actual unit test, since jsdom has no such global. |

---

## Verification

The suite cannot catch what matters here, and this repo has the receipts: phase 3 shipped 200 green tests and a real browser found a bug in thirty seconds; phase 5 shipped 472 green tests with *nobody having opened the UI*. Load the **`nexus-verification`** skill before claiming any of this works.

**Automated — necessary, not sufficient:**

```
npm run test:all                # both suites
npm run typecheck               # a green vitest run does NOT mean it compiles
npm --prefix client run build   # the only command that type-checks TSX
```

**Manual, and non-negotiable:**

1. **Two browsers, one room.** Alice opens `a.ts`, Bob opens `b.ts` — confirm independent selection. Then prompt the agent to edit a third file and confirm *both* panes auto-follow to it, and that pinning stops the follow.
2. **The governance moment.** Ask the agent to edit a file. Confirm the approval card renders a real diff with real line numbers — then have a **non-driver** approve it, and confirm the write lands. This is the feature; if it only works for the driver, I2′ regressed.
3. **The path jail, by hand.** `curl` the file endpoint with `?path=../../../etc/passwd`, with a URL-encoded variant, and against a symlink committed into a test repo pointing at `/etc`. All must 400. A green unit test here is not evidence — this is the surface where being wrong is worst.
4. **The watcher on Linux.** Run the Docker image and edit a file *in a subdirectory* of the room's workspace. If only top-level changes appear, the recursive fallback is wrong — the exact bug a platform gate would have shipped.
5. **Truncation.** Run `npm install` inside a room workspace. Confirm one `truncated: true` frame and a tree refetch — not 50,000 frames, and not silence.
6. **Model switch mid-session.** Switch models between turns and confirm the agent retains its context — that is I1 holding through `setModel`.
7. **Shiki chunk size.** Inspect `client/dist/assets/` after a build. Open a room and confirm the Shiki chunk is *not* fetched until the Files tab is opened.
8. **Contrast + keyboard.** Measured contrast on diff add/remove backgrounds; full keyboard traversal of the tree and tabs. Phase 5 skipped both and that debt is still open.

**Then run the standing harnesses** (`acceptance.mjs`, `restart-recovery.mjs`, kept outside the repo — see the newest session ledger) against a room whose log contains the new events, to confirm replay and restart recovery still reconstruct correctly with `model_changed` and `context_usage` present.

Finish with a session ledger per the **`nexus-session-ledger`** skill.

---

## Deferred, deliberately

- **Browser preview pane** — needs a port-detecting reverse proxy; tab stub only.
- **Human editing / Yjs** — `BUILD_SPEC.md` §2 defers collaborative text editing; N humans plus an agent on one filesystem is a different project.
- **Shared/synchronized file selection** — per-person plus auto-follow gets the "we're looking at the same thing" benefit without arbitration.
- **`.gitignore`-aware tree filtering** — fixed deny-list instead.
- **Room teardown** — the watcher inherits the process-lifetime scope every other room resource already has. Adding a teardown path here alone would be scope creep.
