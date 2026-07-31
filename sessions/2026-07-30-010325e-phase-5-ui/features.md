# Features — 2026-07-30, phase 5 UI

Two design plans written, then executed by a 15-agent workflow. This session
built the product's entire visual layer: a public marketing site with legal
documents, and a redesign of the room itself.

**Note on concurrency:** a phase-6 GitHub App session was running in this same
working tree throughout. Its commits interleave with these in `git log`. See
`issues.md` §2.

---

## Implemented

### Planning artefacts

- `design-system/nexus/MASTER.md` — the shared token set. Both `ui-ux-pro-max`
  queries (marketing → *Trust & Authority*, room → *Modern Dark*) independently
  resolved to the same palette and typeface, so one token set serves both
  surfaces and they differ only in density and motion. Records measured contrast
  per pair and the light-mode accent darkening (`#22C55E` on white is 1.8:1 —
  a naive inversion of a dark-first palette is unreadable).
- `docs/plans/phase-5a-marketing-site.md` — 8 tasks, repo TDD format.
- `docs/plans/phase-5b-room-ui-redesign.md` — 8 tasks, repo TDD format.
- `docs/plans/README.md` — order-7 rows added to the dispatch manifest.

### Phase 5a — marketing site and legal docs

- **Design tokens** — `client/src/design/tokens.ts`, CSS custom properties in
  `index.css`, exposed as Tailwind semantic utilities (`bg-surface`, `text-fg-muted`,
  `border-border`, `text-accent`, `text-warn`, `text-danger`, …). Components
  never write raw hex.
- **Router** — `client/src/routing.ts` (pure `resolveRoute`, no React imports)
  re-exported through `client/src/router.tsx` (the component). The split is
  deliberate: the logic is testable without pulling in the page module graph.
  ~40 lines total, no `react-router` dependency for six routes.
- **Landing page** — `Landing.tsx` plus seven sections (Hero, Problem,
  HowItWorks, Governance, Invariants, SecurityHonesty, Status) and three shared
  components (SiteHeader with skip-link and mobile disclosure menu, SiteFooter,
  RoomMock). RoomMock is static, `aria-hidden`, and captioned as a mockup — it
  does not animate or imply live data.
- **Legal documents** — `LegalLayout` + `Privacy.tsx`, `Terms.tsx`,
  `Security.tsx`, 68ch measure, 16px body. Every factual claim derived from and
  verified against the implementation.
- **`MalformedLink.tsx`** — what a room route renders when the link is incomplete.
- **`CreateRoom.tsx`** — restyled to tokens, inline `sk-ant-` validation before
  the round trip, and a copy-link success step instead of an auto-redirect.
  *(Subsequently extended by the concurrent phase-6 session with GitHub connect UI.)*
- **Server page-route allow-list** — `src/server/index.ts`, an explicit
  `PAGE_ROUTES` list rather than a catch-all, preserving the property that an
  unmatched `/api/*` path 404s instead of silently returning `index.html` with a 200.
- **`client/index.html`** — `referrer: no-referrer` (the room token lives in the
  query string and would otherwise leak via `Referer` on any outbound link),
  description, OG/Twitter tags, `color-scheme`, Inter with `display=swap`.

### Phase 5b — room UI

- **Agent activity indicator** — `agentStatus.ts` derives
  `idle | thinking | streaming | tool | awaiting` from the event tail; matches
  tool results to starts by `toolUseId` and decisions to requests by `requestId`,
  never by position. `awaiting` outranks everything — a blocked room is the most
  urgent fact on screen. Rendered by `AgentActivity.tsx`.
- **Participant identity** — `identity.ts` hashes `participantId` into a stable
  hue, so the same person is the same colour on every screen and across reloads.
  `Avatar.tsx`, redesigned `Roster.tsx`. The 🚗 emoji is gone, replaced by a
  lucide `Crown`.
- **Driver arbitration surfaced** — `DriverRequestNotice.tsx`. `driver_requested`
  was written to the log by the server and dropped by `store.ts#applyEvent`, so
  asking for control was silent to everyone. The driver now gets an actionable
  Grant/Dismiss card; others see a quiet indicator.
- **Keyboard control** — `hooks/useHotkeys.ts`, `ShortcutHint.tsx`,
  `ShortcutCheatsheet.tsx`. `⌘K` switcher, `⌘⇧D` toggle driver, `⌘⇧G` grant,
  `⌘⏎` send, `Esc` arm-then-interrupt, `?` cheatsheet.
- **Room switcher** — `rooms.ts` (localStorage, capped at 10, every access in
  try/catch) + `RoomSwitcher.tsx` command palette with per-entry Forget, Forget
  all, and a visible shared-device warning.
- **Approval cards** — `ApprovalPrompt.tsx` rewritten with `ToolSummary.tsx`
  (plain-language description, raw JSON behind a disclosure) and
  `CountdownRing.tsx`. Unknown tools classify as `destructive` — failing safe.
- **Notices** — `Notice.tsx` / `NoticeStack.tsx`, severity-typed with recovery
  actions; `4409` offers a re-key dialog. `ErrorBanner` and `ConnectionStatus`
  rewritten over it.
- **Transcript** — `MessageList.tsx` with author-hued attribution,
  `ToolCallRow.tsx` (collapsible, errors expanded) and `ScrollAnchor.tsx`, which
  suppresses auto-scroll when the reader has scrolled up and offers jump-to-latest.
- **Layout** — `RoomHeader.tsx`, `SideRail.tsx`, and `App.tsx` recomposed into
  three regions with the prompt row sticky.

---

## Tested and verified

Every number below was produced by running the command in this session, not
taken from an agent's report.

| Evidence | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm --prefix client run build` | exit 0 (the only command that type-checks TSX) |
| `npm test` | **245 passed / 245**, 33 files |
| `npm run test:client` | **227 passed / 227**, 28 files |
| `npm test -- static-routes` | 4/4 — page routes serve the shell, `/api/*` still 404s |

Test count across both suites went from **261 → 472** this session. A large part
of that is not new coverage but *newly visible* coverage — see `issues.md` §1.

Two adversarial passes were run by independent read-only agents:

- **Accessibility / design-system audit.** Six findings; five critical/high
  repaired and re-verified (raw palette classes in three legacy components, a
  missing focus ring on `StopButton`, an untrapped `RoomSwitcher` dialog, and —
  the one that mattered most — `ReKeyDialog` rendering `role="dialog"
  aria-modal` with *no focus management at all*: no focus-in, no Tab trap, no
  restore).
- **Legal-copy fact audit.** Every claim in `/privacy` checked against
  `redact.ts`, `event-log.ts`, `rooms.ts`, `create.ts`, `ws.ts`, including a
  search of all of `src/` for any deletion or expiry path. **Zero
  discrepancies.** The landing page was separately audited for fabricated social
  proof — none found.

## NOT verified — do not treat as done

**Nobody has looked at any of this in a browser.** That is the honest headline.
Three verifications the plans require were not run:

1. **Browser pass** — two Chrome tabs, one room, `PORT=8099`. Avatars stable and
   distinct across tabs, activity indicator tracking a real turn, a driver
   request appearing in the other tab, `⌘K` switching, a non-driver deciding an
   approval.
2. **Keyboard-only pass** — a full turn without a mouse, focus visible
   throughout, no traps.
3. **Measured contrast audit** — with a tool, in both colour schemes. `--danger`
   on `--surface-2` (~3.5:1) and the light-mode accent pairs are the known-tight
   cases.

One accessibility finding is also unfixed: `StopButton` is ~36px tall against
the 44px minimum (`issues.md` §6).

---

## Next steps

1. **Run the three verifications above.** This repo's own history is the
   argument: phase 3 shipped 200 green tests and a real browser found a bug in
   thirty seconds. A UI phase is the single worst place to skip this.
2. Fix `StopButton`'s touch target, and decide on the `accent`/`accent-dim`
   contrast pair (`issues.md` §5).
3. Re-read `/privacy` against the phase-6 changes. The fact audit was run
   *before* phase 6 finished landing GitHub App support; a feature that clones
   private repositories and opens pull requests under a user's installation
   almost certainly changes what the privacy policy needs to say.
4. Screenshots at 375px and 1440px for the record.
