# Issues — 2026-08-03, phase 7 workspace IDE

## Resolved

### 1. Six defects in the phase-7 design plan, found by compiling it

`CLAUDE.md`: *a plan is not a specification until someone has tried to compile
it.* Two of these would have stopped an agent on its first step.

| # | The plan said | Reality |
|---|---|---|
| 1 | Add the `set_model` branch to `src/server/ws.ts` | `ws.on('message')` and the whole `parseClientFrame` switch are at **`src/server/index.ts:422`**. `ws.ts` has no message handling at all → immediate `BLOCKED`. |
| 2 | "`null` maps cleanly" to `setModel` | `setModel(model?: string)` takes `string \| **undefined**`. Passing `null` is a type error. Needs `model ?? undefined`. |
| 3 | Export `GitRunner`, `defaultGit`, `runGit` — "currently module-private" | `GitRunner` is **already exported** (`publish.ts:60`). |
| 4 | `RoomShell`'s `main` + `SideRail` split at `App.tsx:438` | `<main>` is at `:441`, and **`SideRail` renders twice** — `:517` desktop and `:551` in the `lg:hidden` sheet. |
| 5 | Marker regions "must be placed before dispatch" | None existed. |
| 6 | 7b and 7c own disjoint files | Their `App.tsx` regions **nest** — the prompt row sits inside the layout 7b replaces. |

Every SDK citation in the plan, by contrast, was **exact** —
`runtimeTypes.d.ts:111`/`:135`, `coreTypes.d.ts:15`/`:510-512`, and `modelUsage`
on both result subtypes. A useful pattern: the author verified hard external
dependencies carefully and guessed at easy internal ones.

### 2. My own dispatch prompt asked for something impossible

I told 7a to confine `index.ts` edits to the two marker regions and referenced a
`// phase-7 import anchor` line — which I had placed in `App.tsx` but **never in
`index.ts`**. Worse, it could not have worked: **both marker regions are inside
function bodies**, and ES module `import` statements must be at module top level.

The agent added three imports above the existing block with a comment explaining
why, and **reported the deviation** instead of silently widening scope. This is
`CLAUDE.md`'s "your dispatch prompt is specification, not commentary" running the
right way for once — the agent noticed the spec was impossible rather than
faithfully implementing something broken.

### 3. `attachRoom` would have watched the entire repo in every test

7a found this unprompted. `tests/server/ws.test.ts`'s `stubbedRoom()` pointed
rooms at `cwd: process.cwd()` — the whole Nexus checkout. Once `attachRoom`
starts a real recursive `fs.watch`, every one of those tests opens a recursive
watch over ~40k files including `node_modules`. Swapped for `mkdtempSync`.

It would never have failed a test. It would just have made the suite quietly
miserable — the kind of defect no assertion is looking for.

### 4. A cross-agent seam that existed in neither agent's world

`GET /api/rooms/:id/models` had **no specified response envelope**: 7a's plan
listed the route and its guard but never said what it returned, and 7a was
writing the handler while 7c consumed it.

7c assumed `{ models: ModelOption[] }`, **documented the assumption in a
comment**, and flagged it for reconciliation rather than guessing silently. On
verification it matched exactly — `listModels()` passes the SDK's `ModelInfo`
through verbatim, and `ModelOption` is `{value, displayName, description}` field
for field. Comment updated to record the reconciliation.

The lesson is about the *plan*, not the agents: a route's response shape is part
of the contract and belongs in whichever plan owns the producer.

### 5. My integration test was wrong and I briefly blamed the code

Writing the `set_model` integration test, I fired `fireEvent.change(select,
{value: ''})` and asserted the component sent `null`. It sent `''`, and I read
that as a defect. It was not: `ModelSelector` uses a `'__default__'` sentinel,
and a real `<select>` can only ever emit a value it owns — `''` was a value no
browser could produce.

Fixed by driving the option the user actually sees and reading *that option's*
value rather than hardcoding the sentinel. Worth recording because the failure
mode is seductive: a synthetic event that bypasses a real widget's constraints
produces a confident, wrong bug report.

### 6. `noUnusedLocals` is not set in the client tsconfig

After integration, `PromptInput`, `StopButton` and `derivePending` imports plus
the whole `railBadgeCount` chain were dead — and **the client build stayed
green**. Cleaned by hand. Worth knowing that dead code will not announce itself
here; the build is not a lint.

---

## Unresolved — carry these forward

### 7. Seven of the plan's eight manual verifications are unrun

Listed in full in `features.md`. The two that matter most:

- **The governance moment** — a non-driver approving a rendered diff and the
  write landing. That is the entire point of the phase, and no test asserts it.
- **The path jail by hand** — `curl` with traversal, encoding and a committed
  symlink. Unit tests pass and five mutants died, but this is the surface where
  being wrong is worst, and the plan is explicit that a green unit test is not
  evidence here.

### 8. The watcher has never run on Linux

`recursive: true` is requested inside a try/catch with a fallback, deliberately
*not* behind a `process.platform` gate. That is the right shape — but it has only
ever executed on macOS. If the fallback is silently taking over inside the Debian
container, subdirectory edits will not appear and nothing will say so.

### 9. No live agent has driven any of this

`context_usage` and `model_changed` have only ever been produced by synthetic
`translate()` inputs. `setModel` has only been called on a stub. The claim that
switching models mid-session preserves the agent's context (I1 through
`setModel`) is **unobserved** — it rests on the SDK's documented behaviour, not
on having watched it.

### 10. Replay/recovery unverified with the new event types

The standing `acceptance.mjs` / `restart-recovery.mjs` harnesses have not been
run against a room whose log contains `model_changed` and `context_usage`. Both
are in `LOGGED_TYPES` and unit-tested for it, but the end-to-end reconstruction
has not been exercised.

### 11. Carried from phase 5, now two phases old

Keyboard-only pass and measured contrast audit. The contrast one has grown: diff
add/remove backgrounds are new tinted surfaces that nobody has measured.

## Process notes

- **The three-way fan-out was reduced to a three-way build plus a solo
  integration**, deliberately. 7b and 7c's `App.tsx` regions nest, and phase 5's
  `issues.md` §2 already records that marker comments prevent *merge* conflicts
  and do nothing about two processes writing one file minutes apart in a shared
  checkout. The design plan's own instruction — "integration is a single owner,
  last" — turned out to be the load-bearing part.
- **The protocol contract was landed solo first** (`d0839b9`), the phase-6 hybrid
  shape. Both client agents then coded against real signatures. Zero integration
  type errors resulted.
- **All three agents were told not to commit.** Concurrent `git commit` in one
  checkout contends on `index.lock`, and an agent committing would sweep up its
  neighbours' half-finished work — the Phase 1 failure.
- All three ran on **Sonnet**, per the model policy. No repeat of phase 6's
  584k-tokens-at-the-wrong-tier.
