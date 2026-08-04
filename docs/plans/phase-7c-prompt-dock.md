# Phase 7c — Client: prompt-dock chrome

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the four pieces of chrome a Cursor-like room needs under the prompt box: a model selector, voice input, a repo/branch bar, and a context-window bar.

**Why:** The room gives its participants almost no situational awareness about the *session itself*. Nobody can see which model is answering, how much context is left before compaction, or which repository and branch the room is bound to — and there is no way to switch models without abandoning the room, because a room owns exactly one `query()` for its lifetime (I1).

**Architecture:** A new `PromptDock.tsx` **composes** `PromptInput` + `StopButton` + four new components. Do **not** edit `PromptInput.tsx`'s internals — its controlled/uncontrolled contract and its existing tests stay untouched. `RoomHeader.tsx` needs no changes; per the approved layout all chrome sits under the prompt box.

**Mode:** PARALLEL with `phase-7a-workspace-server.md`. `ModelSelector` and `ContextWindowBar` consume 7a's protocol additions and can be built against the contract with mocked `fetch` and fixture events; **merge after 7a.**

**Files owned:**
- `client/src/components/{PromptDock,ModelSelector,VoiceInputButton,RepoBranchBar,ContextWindowBar}.tsx` (all new)
- matching `__tests__` files
- `client/src/App.tsx` — **only inside the `phase-7 prompt dock` marker region** and the `// phase-7c import anchor` line

Anything outside these globs: stop and report `BLOCKED`. In particular `client/src/components/PromptInput.tsx` and `StopButton.tsx` are **read-only** to you, `client/src/workspace/**` and the workspace components belong to 7b, and all of `src/server/**` belongs to 7a.

---

## Global Constraints

- `npm run test:client` and `npm --prefix client run build` must exit 0 before any commit. The client build is the only command that type-checks TSX.
- **Shared-file discipline.** 7b is editing `App.tsx` concurrently in the `phase-7 workspace slot` region. Edit only inside `{/* --- BEGIN phase-7 prompt dock --- */}` … `{/* --- END phase-7 prompt dock --- */}`, and add imports only immediately below `// phase-7c import anchor`. Do not reformat, reorder or tidy anything else in that file.
- **I2′ — the prompt input is never gated on the driver token.** `App.tsx:110-115` explains this at length: anyone may speak. Do not add a driver check to `PromptInput`, do not disable it for non-drivers, do not visually imply non-drivers cannot type. **`ModelSelector` is the one exception and it is a different control** — switching the model changes the session for everyone, so it is driver-gated when a driver exists, and that gate is enforced at the server by 7a regardless of what this UI does.
- **I3 — derive, never duplicate.** Current model and context usage come from `view.events`. Do not add a `useState` mirroring something the log already knows; it will desynchronise on replay, reconnect and resume.
- **Never fabricate a number.** See `ContextWindowBar` below. This is the single most important rule in this plan.
- Read `design-system/nexus/MASTER.md` first. Room density is the dense scale. No raw hex.
- **No new dependencies.** Voice input uses the platform Web Speech API.

---

### Task 1: `RepoBranchBar`

**Files:** `client/src/components/RepoBranchBar.tsx`, `__tests__`

The cheapest of the four and it depends on nothing new — build it first to get the dock's layout settled.

- [ ] **Step 1: Write the failing test** — a room with a GitHub binding renders `owner/repo` and the branch; a room **without** one renders an explicit "no repository" state rather than an empty bar.
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Write the component**

  Use `deriveGithubBinding(view.events)` — **it already exists** at `client/src/githubBinding.ts`. Branch is `nexus/<roomId>`, per `publish.ts`. Pure derivation, no new state, no fetch.

- [ ] **Step 4: Run tests and commit**

---

### Task 2: `VoiceInputButton`

**Files:** `client/src/components/VoiceInputButton.tsx`, `__tests__`

- [ ] **Step 1: Write the failing test**

  **The unsupported state is the actual unit test here**, because jsdom has no `window.SpeechRecognition` — so the default test environment exercises exactly the path most likely to ship broken. Assert it renders a graceful disabled state with an explanatory label rather than throwing or rendering a dead button.

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Write the component** — Web Speech API → `PromptInput.onChange`. No protocol change, no server involvement. Feature-detect both `SpeechRecognition` and `webkitSpeechRecognition`.
- [ ] **Step 4: Run tests and commit**

---

### Task 3: `ContextWindowBar`

**Files:** `client/src/components/ContextWindowBar.tsx`, `__tests__`

- [ ] **Step 1: Write the failing tests**

  Three cases:
  1. A `context_usage` event present → the ratio renders.
  2. `compactedFromTokens` set → a compaction marker renders.
  3. **No `context_usage` has arrived yet → renders "usage unavailable".**

  Case 3 is not an edge case, it is the state every room is in until its first turn completes.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Write the component**

  Source of truth is the **last `context_usage` event**. Ratio is `(inputTokens + cacheReadInputTokens + cacheCreationInputTokens) / contextWindow`.

  **If no `context_usage` has arrived, render "usage unavailable" — never a fabricated percentage.** A context bar that shows 0% when it simply does not know is worse than one that admits it: a participant makes a real decision about whether to start a long task based on that number.

- [ ] **Step 4: Run tests and commit**

---

### Task 4: `ModelSelector`

**Files:** `client/src/components/ModelSelector.tsx`, `__tests__`

- [ ] **Step 1: Write the failing tests**

  Mock `fetch` for `GET /api/rooms/:id/models` (sends `X-Nexus-Token` as a header). Assert: the list populates; selecting sends `{kind:'set_model', model}`; the current model is derived from the **last `model_changed` event**, not from local state; and a **non-driver sees it disabled with an explanatory tooltip while a driver exists**, but enabled when the floor is open.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Write the component**

  The "use the default model" option sends `model: null` — **explicitly `null`, never `undefined`**, which would not survive `JSON.stringify` and would arrive as a malformed frame.

  The disabled state is a courtesy, not the enforcement: 7a rejects a non-driver's `set_model` at the server. Say so in a comment so a later reader does not "simplify" the server check away on the grounds that the UI already prevents it.

- [ ] **Step 4: Run tests and commit**

---

### Task 5: `PromptDock` and integration

**Files:** `client/src/components/PromptDock.tsx`, the `phase-7 prompt dock` region of `App.tsx`

- [ ] **Step 1: Write the failing test** — the dock renders `PromptInput`, `StopButton` and all four chrome components, and `PromptInput`'s existing behaviour is unchanged.
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Write `PromptDock.tsx`** — composition only. `PromptInput.tsx` and `StopButton.tsx` are read-only to you.
- [ ] **Step 4: Integrate** inside the `phase-7 prompt dock` markers in `App.tsx`.
- [ ] **Step 5: Fix `StopButton`'s touch target while you are here — 44px minimum.**

  Carried unresolved from phase 5 (`sessions/2026-07-30-010325e-phase-5-ui/issues.md` §7): it is ~36px tall (`rounded px-3 py-2 text-sm`, no `min-h-11`) against the 44×44px floor the design system states and every other control honours. **This is the one edit you may make to `StopButton.tsx`** — a class change only, no logic.

- [ ] **Step 6: Run the full gate and commit** — `npm run test:client && npm --prefix client run build`, and report the test count delta.

---

## Report notes

- Confirm `PromptInput.tsx` is byte-identical to what you started with.
- Confirm `ContextWindowBar` renders "usage unavailable" rather than 0% on a room with no completed turn — state how you verified it.
- Report whether the voice button's unsupported path was actually exercised by the suite (it should be, since jsdom lacks the API) or whether you had to stub something.
