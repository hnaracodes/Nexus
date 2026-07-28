# Issues — 2026-07-28

## Resolved

### 1. Build emitted to the wrong path and shipped tests into production

**Symptom.** `node dist/server/index.js` → `MODULE_NOT_FOUND`. No test caught
it; the suite never runs the built output.

**Root cause.** `tsconfig.json` had `rootDir: "."` with
`include: ["src/**/*.ts", "tests/**/*.ts"]`. Two top-level directories mean
`tsc` emits `dist/src/…` and `dist/tests/…`. But `npm start` **and**
`phase-1c`'s Dockerfile `CMD` both expect `dist/server/index.js`. Second defect
in the same config: the whole test suite landed in the directory the Dockerfile
copies into the production image.

**Fix.** Split the configs — `tsconfig.json` is now `noEmit` over `src` +
`tests` (new `npm run typecheck`); `tsconfig.build.json` emits `src` alone with
`rootDir: "src"`. Verified `dist/server/index.js` exists and no `dist/tests`.
Commit `187c978`.

**Lesson.** Every test passed while the artifact was unrunnable. Run the built
output, not just the suite.

### 2. Critical advisory in the test toolchain

**Symptom.** `npm audit` after install: 5 vulnerabilities, 1 critical.

**Root cause.** All `vitest <= 3.2.5` pull a `vite`/`esbuild` chain with a
path-traversal high and a critical "arbitrary file read and execute when the
Vitest UI server is listening."

**Fix.** Bumped `vitest` `^2.1.0` → `^4` (resolved 4.1.10). `npm audit` → **0
vulnerabilities**. All 27 tests pass unchanged; no API migration needed.
Commit `df90a6e`.

### 3. Hand-rolled Node↔Fetch adapter (avoided)

The plan dropped `@hono/node-server` and hand-wrote `IncomingMessage` →
`Request` conversion, which mishandles array-valued headers. Replaced with the
package's `createAdaptorServer`, which builds a server **without listening** —
exactly the seam the tests need. Commit `187c978`.

---

## Unresolved — carry into the next session

### A. `CanUseTool` signature in `phase-2c` is wrong

`docs/plans/phase-2c-permission-core.md` assumes a **two**-parameter callback.
Installed SDK **0.1.77** declares three:

```ts
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; suggestions?: PermissionUpdate[];
             blockedPath?: string; decisionReason?: string; toolUseID?: string }
) => Promise<PermissionResult>;
```

`PermissionResult` is confirmed as
`{behavior:'allow', updatedInput, …} | {behavior:'deny', message, interrupt?, …}`
— the deny branch the plan assumed is correct.

**Action:** correct the plan's Task 2 before dispatching `phase-2c`, or the
implementer writes a callback the SDK will not accept. Note `options.signal`
should abort a pending room decision, which the plan does not yet handle.

### B. An invalid API key fails completely silently

**Observed.** Created a room with `sk-ant-api03-SMOKETEST-not-a-real-key`, sent
a prompt, waited ~30s: zero `agent_error` events, zero server log output, room
stayed alive and responsive. The failure never reaches the room.

**Why it matters.** `phase-3d` builds error translation on the assumption that
errors *arrive*. Here there is nothing to translate — a user sees a room that
accepts prompts and does nothing forever. Also weakens the `phase-3c` premise
that a bad key is caught at creation.

**Not diagnosed:** whether the SDK swallows the auth failure, whether the CLI
subprocess spawns at all, or whether it fails slower than 30s. Needs a real key
to compare against a working baseline — do this during `phase-1c`'s smoke test.

### C. Day 1 acceptance test only half-verified

Transport verified (two clients, identical `seq`, replay works). An actual
agent *response* was never observed — no valid Anthropic key. Re-run before
declaring Day 1 done.

### D. A pre-existing `CLAUDE.md` edit was swept into commit `187c978`

`git add -A` included an uncommitted working-tree change that pre-dated this
session's work: deletion of a warning claiming this folder was not its own repo
and that `git add -A` would stage the user's home directory.

**Verified after the fact:** `git rev-parse --show-toplevel` is the Nexus
folder, 35 tracked files, nothing outside the project. The warning was stale
and its deletion correct — but it should not have ridden along in an unrelated
commit. **User decision:** keep, or revert that hunk.

**Lesson.** Prefer explicit pathspecs over `git add -A` when the working tree
holds changes you did not make.
