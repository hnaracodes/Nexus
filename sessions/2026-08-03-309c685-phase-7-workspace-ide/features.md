# Features — 2026-08-03, phase 7 workspace IDE

Two halves. First a records pass (phases 5 and 6 marked verified on the user's
report), then phase 7 built end to end: decomposed, dispatched three ways,
integrated solo, mutation-tested.

## Implemented

### Records brought current

- **Phase 6 → 100%**, all five live bars checked, `docs/github-app-setup.md`
  reframed from "the thing that converts phase 6 from written to working" into a
  setup procedure for new deployments plus a **regression checklist**.
- **Phase 5 → 90%**, two-browser pass marked done. Deliberately *not* 100: the
  keyboard-only pass and the measured contrast audit were not part of the user's
  report and remain open.
- **`README.md` corrected.** It still claimed nothing had ever been deployed, and
  described **I2** ("a non-driver's input is rejected by the server") rather than
  the **I2′** open floor that replaced it in phase 4.
- **Default branch is `main`.** Git already was — no `master` branch exists and
  `origin/HEAD → origin/main`. The stale part was documentation telling
  dispatchers to substitute `master` in `git merge-base main HEAD`. Session
  ledgers and completed phase-3/4 plans left alone as historical record.

### Phase 7 decomposition

`phase-7-workspace-ide.md` carried no `### Task N:` headings, so nothing could
consume it. Now three dispatch-ready plans — `phase-7a` (6 tasks), `phase-7b`
(7 tasks), `phase-7c` (5 tasks) — and the design plan became the architecture
record. **Six defects were found by compiling it against the real tree**; see
`issues.md` §1. All five marker regions and both import anchors placed on `main`
before dispatch.

### 7a — server (`0b273ec`)

- **`src/server/workspace.ts`** — the jail. `realpathSync` on **both** candidate
  and root, case-folded prefix compare, `path.sep` boundary check rather than a
  bare `startsWith`, NUL rejected before touching the filesystem, `not_found` vs
  `invalid` distinguished so routes 404 rather than 500. `listTree` one level,
  re-jails every child, denies `.git`/`node_modules`, ignores `.gitignore` on
  purpose. `readWorkspaceFile` returns `text | binary | too_large`, 1 MiB cap,
  NUL-sniff binary detection over the first 8 KB.
- **`src/server/watcher.ts`** — 300 ms debounce, `recursive: true` unconditionally
  inside try/catch (never a `process.platform` gate), 200-path cap shipping
  `truncated: true` **alongside** the paths that fit, `fs.watch` throw degrades to
  a no-op watcher rather than failing room attachment.
- **`src/server/gitStatus.ts`** — reuses `publish.ts`'s `GitRunner` seam rather
  than a second `execFile` wrapper. `status --porcelain=v1 -z`, `--` before any
  room-supplied path. No `git log`, no `origin/<branch>` — the `--depth 1` clone
  makes both unreliable and fetching would reopen the SSRF surface `create.ts`
  exists to control.
- **`agent.ts`** — `AgentHandle.setModel` / `listModels`; `translate()` emits
  `context_usage` per model key plus a `compact_boundary` branch.
- **Five REST routes** behind the same `X-Nexus-Token` + `authorize()` guard as
  `GET /api/rooms/:id`, path as a query param, no token query-param fallback.
- **`set_model` branch** in `index.ts`, driver-gated only while a driver exists,
  fire-and-forget so the message handler stays non-async.

### 7b — workspace pane (`0894d7b`)

- `derive/workspaceFiles.ts` + `derive/diff.ts` — pure, zero React, LCS diff
  hand-rolled. `deriveCurrentFile` matches tool results to starts by `toolUseId`,
  never by position.
- `workspace/{types,workspaceApi,useWorkspace,highlighter}.ts` — the cache hook
  distinguishes `loading | error | stale | ready`, renders stale content *over*
  the last known good rather than blank-flashing, and reconnect reuses that same
  staleness path so there is one "is this current" code path.
- `FileTree`, `CodeViewer`, `DiffViewer`, `ChangesTab`, `WorkspacePane`.
- Shiki via `shiki/core` + per-grammar dynamic imports, theme built inline from
  `design/tokens.ts`.

### 7c — prompt dock (`473c7dc`)

`PromptDock` composing `PromptInput` + `StopButton` + `ModelSelector`,
`ContextWindowBar`, `RepoBranchBar`, `VoiceInputButton`. `PromptInput.tsx` and
`StopButton.tsx` were verified byte-identical afterwards.

### Integration (`309c685`) — solo, single owner

Chat column + `WorkspacePane` on `lg`, full-screen `inset-0` sheet below.
`SideRail` deleted with all three sections rehomed and none dropped.
`railBadgeCount` retired with it. Four integration tests added to
`app.test.tsx`. Closed two carry-overs: `StopButton`'s 44px touch target and
`ModelSelector`'s stale envelope comment.

## Tested and verified

Every number below was produced by running the command in this session, not
taken from an agent's report.

| Evidence | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | **296 passed** (36 files), was 245 |
| `npm run test:client` | **361 passed** (47 files), was 252 |
| `npm --prefix client run build` | exit 0 — the only command that type-checks TSX |

**Total 657 tests, up from 497.**

### Mutation testing — 5 mutants, 5 killed

Committed first, each reverted with a precise `sed`, working tree verified clean
after every one.

| # | Mutant | Killed by |
|---|---|---|
| M1 | Jail compares realpath'd child against **raw** root | 7 tests |
| M2 | `setModel(model ?? undefined)` → pass `null` through | 1 test |
| M3 | Watcher ships `truncated` with an **empty** path list (a silent cap) | 1 test |
| M4 | Delete the I2′ non-driver gate on `set_model` | 1 test |
| M5 | Anchor a diff on the first of **multiple** `old_string` matches | 2 tests |

M5 is the governance-critical one: it proves the code refuses to fabricate line
numbers rather than silently anchoring on an ambiguous match.

### Bundle — verified from a real build, not assumed

Shiki splits correctly. Main bundle `270.39 → 294.00 kB` (`78.79 → 85.55 kB`
gzip) — that growth is the new components, **not Shiki**. Shiki lands in its own
chunks: `highlighter` 36.86 kB gzip, one chunk per grammar, and the oniguruma
wasm as a separate 232 kB gzip chunk fetched only when a grammar is used.

## NOT verified — do not treat as done

**Nobody has opened any of this in a browser, and no live agent has driven it.**
The plan names eight manual verifications; **one** is done (Shiki chunk
splitting, from build output). The other seven are open:

1. **Two browsers, one room** — independent file selection, both panes
   auto-following the agent to a third file, pinning stopping the follow.
2. **The governance moment** — the actual feature. Ask the agent to edit a file,
   confirm the approval card renders a real diff with real line numbers, then
   have a **non-driver** approve it and confirm the write lands. If it only works
   for the driver, I2′ regressed.
3. **The path jail by hand** — `curl` with `../`, a URL-encoded variant, and a
   symlink committed into a test repo. Unit-green is not evidence on the one
   surface where being wrong is worst.
4. **The watcher on Linux** — run the Docker image, edit a file in a
   *subdirectory*. Top-level-only changes mean the recursive fallback is wrong.
5. **Truncation** — `npm install` inside a room workspace: one `truncated` frame
   and a refetch, not 50,000 frames and not silence.
6. **Model switch mid-session** — switch between turns, confirm the agent keeps
   its context. That is I1 holding through `setModel`.
7. **Shiki not fetched until the Files tab opens** — splitting is proven;
   *fetch timing* is not.
8. **Contrast + keyboard** — still open from phase 5, now with diff add/remove
   backgrounds added to the list.

Also unrun: the standing `acceptance.mjs` / `restart-recovery.mjs` harnesses
against a room whose log contains `model_changed` and `context_usage`, to confirm
replay and restart recovery still reconstruct correctly.

## Next steps

1. **The browser pass and the governance moment.** Everything else is smaller
   than what those two find.
2. The path jail by hand, and the watcher inside the Docker image.
3. Re-run the standing harnesses against a log carrying the new event types.
4. Keyboard-only pass and measured contrast audit — now two phases old.
