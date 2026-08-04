# Progress — after phase 5 (UI)

> **Update, 2026-08-03 — the browser pass happened; phase 5 goes 80% → 90%, and
> phase 6 goes 75% → 100%.** Both reported by the user directly (human tester,
> with Claude Code and Cursor, in an earlier run), not re-run by an agent in this
> repo. The missing 20% below was described as "one thing: nobody has looked at
> it" — that is now two-thirds retired. The **keyboard-only pass** and the
> **measured contrast audit** are still owed, which is why this is 90 and not
> 100; `CLAUDE.md`'s rule that unverified work recorded as done is worse than not
> recording it cuts both ways, and rounding two genuinely-unrun verifications up
> to complete would be the same error in the other direction. Original numbers
> and reasoning left intact below.

## Status

The MVP was complete, deployed and demoed before this session. Phase 5 is
**post-MVP**, so the honest framing is three numbers, not one.

**MVP: 100%.** Unchanged. Live at `https://nexus-mvp.fly.dev/`, hardened,
demoed, browser-passed. This session did not add MVP scope. It did materially
improve the MVP's *presentation* — the room it ships is no longer nine unstyled
components — but presentation was never in the MVP's definition of done.

**Phase 6 (GitHub App): ~~75%~~ → 100%** as of 2026-08-03 — the five live bars
pass against a real GitHub App. Carried forward from
`sessions/2026-07-30-3bd306e-phase-6-github-app/progress.md`, which now records
the same.

**Phase 5 (UI): ~~80%~~ → 90%** as of 2026-08-03. The figures and reasoning
below are this session's own, as of 2026-07-30, and were not recomputed.

## Per-area breakdown — phase 5 only

| Area | State | % |
|---|---|---|
| Design system (`MASTER.md`) | Tokens, type, spacing, motion, icons, measured contrast table | 95 |
| Marketing landing page | 7 sections + header/footer/mock, responsive markup written | 85 |
| Legal docs (privacy/terms/security) | Written from the code; fact-audited clean — but pre-phase-6 | 80 |
| Routing (client + server allow-list) | Legacy-link compatibility tested; `/api/*` 404 guard committed | 100 |
| Room: agent activity indicator | Pure derivation, 9 unit tests incl. concurrent-tool case | 95 |
| Room: identity, roster, driver arbitration | Emoji gone; `driver_requested` surfaced for the first time | 90 |
| Room: hotkeys + cheatsheet | Built with both safety rules (local `a`/`d`, armed Escape) | 85 |
| Room: switcher | localStorage, forget controls, shared-device warning | 90 |
| Room: approval cards | Fail-safe classification, plain-language summaries | 90 |
| Room: notices + transcript | Severity types, recovery actions, scroll-respecting anchor | 85 |
| **Browser verification** | **Done 2026-08-03, two tabs one room (user-reported)** | **100** |
| **Keyboard-only / measured contrast** | **Still not started** | **0** |

## Reasoning behind 80%

The 20% missing is one thing: **nobody has looked at it.**

Everything above is verified by 472 passing tests, a clean typecheck, a clean
TSX-compiling client build, an adversarial accessibility review that found and
fixed a real focus-management defect, and a legal-copy fact audit that read the
source for every claim. That is a genuinely strong evidence base for logic.

It is a weak evidence base for a *user interface*. jsdom does not lay anything
out, does not paint, does not compute a contrast ratio, and does not tell you
that a side rail overlaps the prompt row at 1024px. The three named
verifications — two-tab browser pass, keyboard-only pass, measured contrast
audit — are precisely the ones that catch what the suite structurally cannot.

This project's own history sets the discount rate. Phase 3 shipped 200 passing
tests and a real browser found a bug in thirty seconds — two people in one room
collapsed into a single roster row because they shared `localStorage`. Phase 4
was scored 80, not 100, for the same reason: unobserved behaviour. Phase 6 was
scored 75 because its tests verify a model of GitHub rather than GitHub. Scoring
an unlooked-at UI at 100 would break a convention this repo has kept three times
in a row, and `CLAUDE.md` is explicit that unverified work recorded as done is
worse than not recording it, because the next session builds on the claim.

The number is 80 rather than lower because the *logic* underneath the pixels is
unusually well covered — the derivations (`agentStatus`, `identity`,
`derivePendingDriverRequests`, `resolveRoute`, `classifyTool`) are pure
functions with real edge-case tests, including the ones that matter for
correctness rather than appearance: tool results matched by `toolUseId` and not
position, unknown tools failing safe to `destructive`, and legacy
`/?room=&token=` links still resolving to the room.

One caveat that keeps the legal docs at 80 rather than higher: the fact audit
was clean, but it ran while phase 6 was still landing. GitHub App support
changes what the product does with user data, and `/privacy` has not been
re-read against it (`issues.md` §9).

## Verification mechanisms — where this session landed

`CLAUDE.md` names three, none redundant:

- **Suites + typecheck + client build** — done, and all four re-run by hand at
  the end rather than trusted from an agent report. 245 root, 227 client. The
  count matters here more than usual: it exposed that 146 tests had never been
  running at all (`issues.md` §1).
- **Adversarial audit** — done, by two independent read-only agents (an
  accessibility/design-system reviewer and a legal-copy fact auditor). Six
  findings, five repaired. Caught a `role="dialog"` with no focus management on
  a recovery path.
- **A real browser** — **not done at the time of writing; done 2026-08-03** by
  the user. This was the entire missing 20%; what is left of it is the
  keyboard-only pass and the measured contrast audit.

Mutation testing was not run this session. Most of the new code is presentational
and mutation testing pays poorly there, but the pure derivations named above
would repay it and are the obvious candidates if someone wants a fourth signal.

## What the next session should do first

1. ~~**The browser pass.**~~ **Done 2026-08-03.**
2. **Keyboard-only pass and measured contrast audit** — the other two named
   gaps, **still open**.
3. **Re-audit `/privacy` and `/security` against phase 6** (`issues.md` §9).
   The site currently describes a product that no longer matches the code.
4. Fix `StopButton`'s 44px touch target, and settle the `accent`/`accent-dim`
   contrast pair in `MASTER.md` (`issues.md` §7, §10).
5. Screenshots at 375px and 1440px for the record.
