# Phase 7b — Client: the workspace pane

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the room's side rail with a tabbed workspace — file tree, syntax-highlighted viewer, and **rendered diffs** of what the agent is doing — so approving an `Edit` means approving a diff instead of a JSON blob.

**Why:** This is the governance payoff, and it is the part the original ask did not contain. `Edit` and `Write` are **not** in `permissions.ts`'s `AUTO_APPROVE` set, so every file edit already fires a `permission_requested` event carrying `{file_path, old_string, new_string}` *before the write happens*. Today `ToolCallRow.tsx` renders that as raw JSON. Rendering it as a diff turns the four-eyes gate from "approve this JSON blob" into "approve this diff" — which is `CLAUDE.md`'s stated thesis, on the surface where the product currently looks weakest.

**Architecture:** Pure derivations over `NexusEvent[]` in `client/src/derive/**`, following `approvals.ts#deriveApprovals` exactly. A REST-backed cache hook in `client/src/workspace/**` that **never imports `store.ts`**. Components consume both.

**Mode:** Depends on `phase-7a-workspace-server.md`'s protocol changes. Its components mock `fetch` and can be built against the contract before 7a merges; **merge after 7a.**

**Files owned:**
- `client/src/derive/**` (new)
- `client/src/workspace/**` (new)
- `client/src/components/{WorkspacePane,FileTree,CodeViewer,DiffViewer,ChangesTab}.tsx` (new)
- `client/src/components/SideRail.tsx` — **deletion**
- `client/package.json` — to add `shiki` only
- `client/src/App.tsx` — **only inside the `phase-7 workspace slot` marker region** and the `// phase-7b import anchor` line
- matching `__tests__` files

Anything outside these globs: stop and report `BLOCKED`. In particular `client/src/components/{PromptDock,ModelSelector,VoiceInputButton,RepoBranchBar,ContextWindowBar}.tsx` belong to 7c, and all of `src/server/**` belongs to 7a.

---

## Global Constraints

- `npm run test:client` and `npm --prefix client run build` must exit 0 before any commit. **The client build is the only command that type-checks TSX**; this repo has already shipped a `tsc -b` failure behind a fully green client suite.
- **Check the test count moved.** Phase 5 shipped 146 tests that were never discovered because `client/vite.config.ts` scoped `test.include` to `tests/**`. It now also includes `src/**/*.test.{ts,tsx}` — but verify your files are actually being run rather than trusting exit code 0. A green suite does not mean it ran.
- **The non-log boundary (I3).** `client/src/workspace/*` **must have no import of `store.ts`**, and `RoomView` gains **zero** new fields. This is greppable and it will be grepped. File contents are not room history; they are REST-fetched and cached locally. Everything that *is* history — which files were touched, who switched the model — comes from `view.events` like every other view in this app.
- **Every read of `input` goes through a runtime type guard.** `ToolStart.input` and `PermissionRequested.input` are typed `unknown` on the wire. Match `ToolSummary.tsx`'s existing never-throws style. **A cast is not a guard.**
- **Colour never carries meaning alone.** `ToolCallRow.tsx` already states this rule in its own comment, and a red/green-only diff violates it directly. Every diff line gets a `+`/`-`/space **gutter glyph** — also the most familiar convention for this audience — tinted backgrounds are additive, and each hunk carries an `aria-label` with add/remove counts.
- **One new dependency: `shiki`.** No diff library — the line diff is hand-rolled. No editor component. The client goes from 3 to 4 runtime dependencies.
- Read `design-system/nexus/MASTER.md` before styling anything. Never write a raw hex value; use the semantic Tailwind utilities (`bg-surface`, `text-fg-muted`, `border-border`, …).

---

### Task 1: Pure derivations

**Files:** `client/src/derive/workspaceFiles.ts`, `client/src/derive/diff.ts`, `__tests__`

Zero React, zero fetch, unit-tested against fixture events — the `approvals.ts` model exactly.

- [ ] **Step 1: Write the failing tests**

  For `deriveTouchedFiles`, `deriveCurrentFile`, `deriveFileEdits`: fixture `NexusEvent[]` arrays including a `tool_start` whose `input` is `undefined`, a string, and an object missing `file_path` — all must be skipped without throwing.

  For `diffLines`: identical inputs → all context; pure insertion; pure deletion; a replacement; and empty-to-nonempty.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Write `derive/workspaceFiles.ts`**

  `deriveCurrentFile` uses the same **backward-scan-for-an-unresolved-tool** shape `agentStatus.ts` already uses, and matches tool results to starts by `toolUseId` — **never by position**. Phase 5 established this and it is why the activity indicator is correct under concurrent tools.

- [ ] **Step 4: Write `derive/diff.ts`**

  `diffLines` is a plain LCS over two known texts. No dependency.

- [ ] **Step 5: Run tests and commit**

---

### Task 2: The workspace API client and cache hook

**Files:** `client/src/workspace/{types,workspaceApi,useWorkspace}.ts`, `__tests__`

- [ ] **Step 1: Write the failing tests**

  Mock `fetch`. Assert the `X-Nexus-Token` header is sent on every call; that a 401 surfaces as a typed `WorkspaceError` rather than a thrown string; and the four distinct states below.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Write `workspaceApi.ts`**

  Thin `fetch` wrappers over 7a's five routes. The token goes in the `X-Nexus-Token` **header** — 7a deliberately provides no query-param fallback.

- [ ] **Step 4: Write `useWorkspace.ts`**

  Owns a `Map<path, {content, status, error, fetchedAtSeq}>` in its own `useState`. **It never imports `store.ts`.** It receives `touchedFiles` — already derived from the log by `WorkspacePane` — so it can mark entries stale without itself knowing what a `NexusEvent` is.

  - **Stale, not silently refetched.** When a newer edit lands for a cached path, mark it `stale` and render a "content changed — refresh" affordance **over the last-known content**. Never a blank flash.
  - **Reconnect reuses the same staleness path** rather than blind-refetching everything, so there is exactly one "is this file current" code path.
  - Distinguish `loading` / `error` / `stale` / `ready` so the viewer never renders "still fetching" as "empty file."

- [ ] **Step 5: Run tests and commit**

---

### Task 3: Shiki, lazily

**Files:** `client/src/workspace/highlighter.ts`, `client/package.json`, `__tests__`

- [ ] **Step 1: Write the failing test** — an unknown extension falls back to plain `<pre>` rather than throwing.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write `highlighter.ts`**

  **Bundle size is the whole risk here** — the root `shiki` barrel pulls every grammar. Import `shiki/core` + `shiki/engine/oniguruma` and load grammars via **individual dynamic `import()`s**: ts, tsx, js, jsx, json, md, bash, css, html, yaml, python. Everything else falls back to plain `<pre>`.

  A module singleton created on **first Files-tab open**, so a room that never opens the workspace pays zero Shiki bytes.

  Build the theme object inline from `design/tokens.ts`'s `COLORS` rather than shipping a bundled theme — one source of colour truth, and `index.css` already documents the room as dark-only.

- [ ] **Step 4: Verify the emitted chunk**

  **Inspect `client/dist/assets/` after a real build. Do not assume.**

  **Measured baseline before this phase (2026-08-03, `main`):**

  ```
  dist/assets/index-*.css    22.08 kB │ gzip:  5.69 kB
  dist/assets/index-*.js    270.39 kB │ gzip: 78.79 kB
  ```

  Shiki must land in a **separate chunk**, not merged into `index-*.js`. If the main bundle grew materially, the barrel import leaked in — go back to `shiki/core` plus individual dynamic grammar imports. Report both numbers.

- [ ] **Step 5: Run tests and commit**

---

### Task 4: `FileTree` and `CodeViewer`

- [ ] **Step 1: Write the failing tests** — lazy expansion fetches one level; `too_large` and `binary` render explanatory states, not an empty pane; keyboard traversal works.
- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Write `FileTree.tsx`** — recurses lazily, one level per expand, mirroring 7a's non-recursive `listTree`.
- [ ] **Step 4: Write `CodeViewer.tsx`** — renders all four cache states distinctly; line numbers; Shiki when the grammar is available.
- [ ] **Step 5: Run tests and commit**

---

### Task 5: `DiffViewer` — the interesting part

**Files:** `client/src/components/DiffViewer.tsx`, `__tests__`

Whole-file diff (`Write`, git diff) is straightforward LCS over two known texts. **The `Edit` case is not: `old_string` is a fragment, not the file.** Diffing the fragment alone gives a floating hunk with no line numbers and no surrounding code — useless for review, which is exactly what the approval gate needs it for.

- [ ] **Step 1: Write the failing tests**

  Three cases, and the third is the one that matters:
  1. `old_string` occurs **exactly once** in a cached file version → anchored diff with real line numbers.
  2. `old_string` occurs **zero** times (stale cache) → `contextUnavailable: true`.
  3. `old_string` occurs **more than once** → `contextUnavailable: true`.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement anchoring**

  If any version of the file is cached, locate `old_string` as a literal substring, compute its line span, and diff a windowed region — real line numbers, real context.

- [ ] **Step 4: Implement the honest fallback**

  On zero or multiple occurrences, render a contextless fragment diff with `contextUnavailable: true` and a **visible text banner**. **Never fabricate line numbers that look real.** `old_string` uniqueness is an SDK invariant, not one a possibly-stale *client cache* may assume — and a reviewer approving a destructive edit against invented line numbers is a governance failure, not a cosmetic one.

- [ ] **Step 5: Accessibility** — gutter glyphs, additive tints, per-hunk `aria-label` with add/remove counts. `contextUnavailable` is a text banner, never a colour cue.

- [ ] **Step 6: Run tests and commit**

---

### Task 6: `ChangesTab`, and retiring `SideRail`

**Files:** `client/src/components/ChangesTab.tsx`, deletion of `SideRail.tsx`, `__tests__`

**`SideRail` is deleted — rehome all three of its sections, drop nothing:**

| Section | Destination |
|---|---|
| Roster | Already rendered by `RoomHeader`. `SideRail`'s copy is duplicate — nothing lost. |
| `PendingPrompts` | Moves **inline above `PromptInput`**. It is about what is *about to be sent*; it belongs next to the input. |
| Settled approval history | **The only real loss if deleted.** Goes to the top of the **Changes** tab, reusing `deriveApprovals(events).settled` verbatim — same derivation, new renderer. |

- [ ] **Step 1: Write the failing test** — settled approvals render in the Changes tab; pending prompts render above the prompt input.
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Write `ChangesTab.tsx`** — settled approval history on top, git status below.
- [ ] **Step 4: Delete `SideRail.tsx` and both of its call sites.**

  > **Verified against the real file, and the design plan got this wrong.** `SideRail` is rendered **twice** in `App.tsx` — once at `:517` (desktop) and again at `:551` (the `lg:hidden` mobile bottom sheet). The design plan cited a single split at `:438`; the actual `<main>` is at `:441`. **Remove both call sites**, the import at `:21`, and the `railBadgeCount` mechanism that fed the mobile sheet.

- [ ] **Step 5: Run tests and commit**

---

### Task 7: `WorkspacePane` and integration

**Files:** `client/src/components/WorkspacePane.tsx`, the `phase-7 workspace slot` region of `App.tsx`

- [ ] **Step 1: Write the failing tests** — tab switching; auto-follow moves the selection when the agent starts editing a new file; **pinning stops the follow**.
- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Write `WorkspacePane.tsx`** — tabs `Files | Changes | Preview (stub)`. Owns selection and follow/pin state. **Per-person local UI state — no new room state, no arbitration.** Auto-follow the agent's current file is **on by default**; a pin toggle stops it.
- [ ] **Step 4: Integrate into `App.tsx`** — replace the `main` + `SideRail` split with a chat column (fixed, resizable) plus `WorkspacePane` (`flex-1`). **Only inside the `phase-7 workspace slot` markers.** Do not reformat, reorder or tidy anything else in that file — 7c is editing it concurrently in its own region.
- [ ] **Step 5: Responsive**

  Below `lg` (1024px) the workspace column does not render; a "Workspace" button opens it as a `fixed inset-0` **full-screen** sheet. Reuse the retired room-details sheet pattern, but full-screen rather than `70vh` — a code viewer in a 70vh sheet is unusable.

- [ ] **Step 6: Run the full gate and commit** — `npm run test:client && npm --prefix client run build`, and report the test count delta.

---

## Report notes

- Report the **Shiki chunk size** from `client/dist/assets/` and confirm it is a separate chunk, not merged into the main bundle.
- Confirm by grep that nothing under `client/src/workspace/` imports `store.ts`.
- Confirm `RoomView` gained zero fields.
- Name every `unknown` you read from `input` and the guard you used.
