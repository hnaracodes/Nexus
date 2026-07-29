# Commits — 2026-07-28 (session 2, Phase 1 fan-out)

**All commits are local. Nothing was pushed; push was never approved.**
No PRs opened. Branch: `master`.

Listed oldest first.

| Hash | Subject |
|---|---|
| `608310c` | chore: ignore harness worktree directory |
| `ebc6820` | fix(plans): correct phase-2c canUseTool signature against installed SDK 0.1.77 |
| `e56b235` | build: multi-stage Dockerfile for server, client, and runtime |
| `baa4f2e` | test: websocket smoke script proving the upgrade survives a proxy |
| `597c43c` | deploy: fly.io config with persistent volume and always-on machine |
| `bbbe2d2` | docs: phase-1c deploy pipeline implementation report |
| `546a314` | merge: phase-1c deploy pipeline (Dockerfile, fly.toml, ws smoke script) |
| `0767347` | feat(log): redact API keys and truncate tool output at the write boundary |
| `07b2dae` | feat(log): append-only JSONL event log with crash-tolerant reads |
| `e1255b4` | fix(log): cache redacted event, not raw event, to close I4 leak (I4) |
| `7d7982d` | fix(log): cache redacted events and expose the createSink factory |
| `fb02e5c` | merge: phase-1a durable append-only JSONL event log with redaction |
| `7e8410b` | feat(server): make the durable JSONL log the default event sink (I3) |
| `455245b` | chore(client): scaffold Vite + React + Tailwind with vitest and jsdom |
| `c93ab93` | feat(client): idempotent event reducer projecting the room view |
| `458091a` | feat(client): websocket adapter with backoff reconnect and resume-from-seq |
| `92e18a3` | fix(client): cancel pending reconnect timer on explicit close |
| `0500bed` | feat(client): room shell with message list, prompt input, and connection status |
| `4e0fe48` | merge: phase-1b React client shell (reducer, ws adapter, room UI) |
| `63dc8eb` | feat(server): serve the built client bundle |
| `d347068` | docs: refresh CLAUDE.md for the merged Phase 1 fan-out |

## Notes

- Three plans were dispatched concurrently as worktree-isolated agents
  (`phase-1a` sonnet, `phase-1b` sonnet, `phase-1c` haiku) and merged **one at
  a time** with `npm test` between each. **No merge conflicts** — the
  file-ownership partition held.
- Neither `phase-1a` nor `phase-1b` finished on its own. Both stopped while
  waiting on a child fix-agent, leaving their final task undone. The controller
  completed `phase-1a` Task 3 (`src/log/index.ts`, sink-contract tests) and
  `phase-1b` Task 4 (room UI shell) directly.
- `7d7982d` was subsequently dropped from the `worktree-agent-a343516c9ca29cee4`
  branch by a late child agent resetting it. Harmless here — the commit was
  already merged and `master` was verified a strict superset via
  `git diff --stat master 27b0ff5` — but see `issues.md` §8.
