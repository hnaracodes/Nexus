# Progress — after phase 7

## Status

**MVP: 100%.** Unchanged. Live at `https://nexus-mvp.fly.dev/`, hardened,
demoed, browser-passed.

**Phase 4 (open floor): 100%.** Live two-browser pass done by the user.

**Phase 5 (UI): 90%.** Browser pass done 2026-08-03 (user-reported). The
keyboard-only pass and measured contrast audit are still open, which is the
missing 10%.

**Phase 6 (GitHub App): 100%.** All five live bars pass against a real GitHub
App, including the hard requirement — a restart that still clones and publishes
with zero human GitHub interaction.

**Phase 7 (Workspace IDE): 80%.**

## Per-area breakdown — phase 7 only

| Area | State | % |
|---|---|---|
| Protocol (frames + 2 logged events) | Landed solo first; two-edit trap regression-tested per type | 100 |
| Path jail (`workspace.ts`) | 13 tests incl. a real escaping symlink; mutant M1 killed by 7 | 90 |
| Watcher | 7 tests; no-silent-cap mutant M3 killed; **never run on Linux** | 75 |
| Git status/diff | 10 tests, injected `GitRunner`, quoting hazard covered | 90 |
| Model control + telemetry | `setModel` bridge mutant M2 killed; **never called on a real session** | 80 |
| REST routes + `set_model` gate | Traversal returns 400 not 500; I2′ mutant M4 killed | 90 |
| Derivations + diff engine | Pure, 81 tests; fabrication mutant M5 killed by 2 | 95 |
| Workspace cache hook (I3 boundary) | Four states, stale-over-content, grep-verified no `store.ts` import | 90 |
| Shiki | Splitting proven from a real build; **fetch timing unobserved** | 85 |
| Prompt dock | 24 tests; "usage unavailable" asserted negatively too | 90 |
| Integration | 4 new tests over the wires; done solo | 85 |
| **Browser / live-agent verification** | **Not started** | **0** |

## Reasoning behind 80%

The missing 20% is one thing, and it is the same thing this repo has scored
against three times running: **nobody has looked at it, and no live agent has
driven it.**

What *is* verified is unusually strong for code of this age. 657 tests across
both suites (497 → 657 this session), a clean typecheck, a clean TSX-compiling
build, and **five mutants, five killed** — each reverted with a precise edit and
the tree verified clean afterwards. The mutants were chosen to attack the
properties that actually matter rather than the easy ones: the jail comparing a
realpath'd child against a raw root, a silent cap in the watcher, the I2′ gate on
`set_model`, the `null`/`undefined` bridge, and the diff refusing to anchor on an
ambiguous match.

It is still a weak evidence base for **this particular phase**, for three
specific reasons:

1. **The feature's whole point is unobserved.** Phase 7 exists so that approving
   an `Edit` means approving a *diff* rather than a JSON blob. Whether a
   non-driver can approve a rendered diff and have the write land — the
   governance moment — has never been executed. No test can assert it; the plan
   says so explicitly.
2. **The path jail has never been attacked by hand.** Unit tests pass and M1 died
   loudly, but this is the one new surface where being wrong is worst, and the
   plan is blunt that a green unit test is not evidence here.
3. **The watcher has only ever run on macOS.** `recursive: true` inside a
   try/catch with a fallback is the correct shape precisely *because* the Node
   version boundary is uncertain — but if the fallback is silently engaging
   inside the Debian container, subdirectory edits vanish and nothing reports it.
   That is the exact failure a `process.platform` gate would have shipped, and
   avoiding the gate does not prove the fallback is idle.

Why not lower than 80: the design decisions that are expensive to change later
are made and tested. The I3 boundary is drawn explicitly and enforced by grep
rather than by convention. The diff's honest-fallback behaviour — never fabricate
a line number — is the one piece of this phase where a bug would be a governance
failure rather than a cosmetic one, and it is mutation-proven. The protocol
landed before anything consumed it. What remains is *confirmation*, not *design*.

Scoring an unlooked-at UI phase at 100 would also break a convention this repo
has now kept four times (phase 4 at 80, phase 5 at 80, phase 6 at 75, this at
80), and `CLAUDE.md` is explicit that unverified work recorded as done is worse
than not recording it, because the next session builds on the claim.

## Verification mechanisms — where this session landed

`CLAUDE.md` names three, none redundant:

- **Suites + typecheck + client build** — done, all four re-run by hand at the
  end rather than trusted from an agent report. The count matters: 497 → 657, and
  each agent independently verified its own files were *discovered* rather than
  silently skipped by a glob, which is phase 5's lesson applied unprompted.
- **Mutation testing** — done, 5/5 killed. Also produced one methodology note:
  see `issues.md` §5, where a synthetic DOM event that bypassed a real widget's
  constraints produced a confident and completely wrong bug report.
- **A real browser** — **not done.** This is the whole of the missing 20%.

## What the next session should do first

1. **Two browsers, one room, `PORT=8099`** — and inside it, the governance
   moment: agent edits a file, approval card renders a real diff, a **non-driver**
   approves, the write lands. If that only works for the driver, I2′ regressed.
2. **Attack the path jail by hand** — `curl` with `../`, a URL-encoded variant,
   and a symlink committed into a test repo. All must 400.
3. **Run the Docker image and edit a file in a subdirectory.** If only top-level
   changes appear, the recursive fallback is wrong.
4. **Re-run `acceptance.mjs` / `restart-recovery.mjs`** against a room whose log
   carries `model_changed` and `context_usage`.
5. The two phase-5 carry-overs, now two phases old: keyboard-only pass and a
   measured contrast audit — the latter now including diff add/remove tints.
