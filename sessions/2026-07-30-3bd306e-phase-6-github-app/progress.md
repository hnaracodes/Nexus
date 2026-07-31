# Progress — after phase 6

## Status

The MVP was already complete and deployed before this session. Phase 6 is
**post-MVP**, so the honest framing is two numbers, not one.

**MVP: 100%.** Unchanged. Deployed, live at `https://nexus-mvp.fly.dev/`,
hardened, demoed, browser-passed. Phase 6 did not add MVP scope; it fixed one
**critical latent defect in MVP code** (`agent.ts` handing every server env var
to the agent subprocess) and one **high-severity live one** (the unredacted
broadcast), so if anything the MVP is slightly more solid than it was.

**Phase 6 (GitHub App): 75%.**

## Per-area breakdown

| Area | State | Confidence |
|---|---|---|
| Broadcast redaction | Done, TDD red→green, live-socket assertion | High |
| App JWT / token minting / OAuth | Done, 17 tests | High — pure crypto and HTTP shapes |
| Verified-repo binding (anti-spoof) | Done, tested including the refusal path | High |
| Durable binding across restart | Done, round-trip + mutation tested | High |
| Private clone | Done, argv-hygiene proven on success *and* failure | Medium-high |
| Publish → PR | Done, 23 tests, one HIGH bug caught and fixed | **Medium** |
| Routes + connect UI | Done, 21 client tests | Medium |
| Deploy config | Done (`NEXUS_WORKDIR` on the volume) | Untested live |
| **Live GitHub verification** | **Not started** | — |

## Reasoning behind 75%

The 25% missing is a single thing: **none of this has ever talked to GitHub.**

Every GitHub interaction is exercised against an injected `fetch` and an injected
`git`. That is genuinely good for the properties that matter most here — argv
hygiene and the mass-deletion hazard are not observable against a live repository
without risking a real one — but it verifies *my model of GitHub's API*, not
GitHub. Registering an App needs an account no agent in this session had.

This project's own history is the argument for not scoring it higher. Phase 3
shipped 200 passing tests and a real browser found a bug in thirty seconds.
Phase 6 has now had a fan-out, a per-chunk adversarial review, and mutation
testing — and the review still found a HIGH defect that would have proposed
deleting a teammate's commits in a pull request that reported success. Unit
confidence is not deployment confidence.

I have weighted `publish` **medium** rather than high specifically because it is
the piece that writes to somebody else's repository, it had the one HIGH finding,
and its remaining risk (a truncated tree, a moved branch, an odd path encoding)
is exactly the kind that a fake cannot reproduce faithfully.

Why not lower than 75%: the design decisions that are hardest to change later are
made and verified — the ordering (connect → pick → clone → create room, forced by
`Room.cwd` being readonly), the anti-spoof binding, the asymmetric token scoping,
the durable non-secret triple, and publish-as-an-MCP-tool so approval reuses the
existing gate untouched. What remains is largely *confirmation*, not *design*.

## What the next session should do first

1. **Run the setup checklist in `features.md`** and then the five live bars. Until
   that happens, treat phase 6 as "written" rather than "working", and do not put
   it in `CLAUDE.md` as verified.
2. Resize the Fly volume before anyone clones a real private repo into it. 1 GB,
   no eviction.
3. Read `issues.md` §B before touching the clone or publish paths — seven known,
   deliberately-deferred issues are recorded there with reasoning.
4. Note `issues.md` §C: subagent dispatches in this session ran on Opus by
   omission. `agent()` inherits the session model; set `model: 'sonnet'`
   explicitly on every call.
