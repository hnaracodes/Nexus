/**
 * Which binary actually runs the Claude Agent SDK's own subprocess, and why
 * this cannot be left to PATH resolution.
 *
 * Reported live: "Failed to spawn Claude Code process: spawn node ENOENT" —
 * a real desktop install, on the first prompt of a real room. The SDK's own
 * default is the bare string `"node"` (sdk.mjs: `executable: options.executable
 * ?? (isRunningWithBun() ? "bun" : "node")`), spawned through Node's ordinary
 * PATH lookup. `subprocessEnv.ts`'s `buildAgentEnv` passes the AGENT's PATH
 * straight through from the desktop shell's own `process.env.PATH` — and for
 * an app launched the way every real user launches it (Finder, Spotlight, the
 * Dock), that PATH comes ONLY from `/etc/paths` + `/etc/paths.d/*`. It never
 * runs a shell rc file, so wherever `nvm`, `asdf`, `volta`, or a fresh
 * Homebrew install put `node` is invisible to it — which is most machines,
 * because that is precisely how those tools are meant to work. Reproduced
 * exactly, byte for byte, by handing the real SDK the macOS GUI default PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) with no other change.
 *
 * `process.execPath` sidesteps PATH lookup entirely: it is the absolute path
 * to the binary already running THIS process, so it always resolves, always
 * matches the Node version already in use, and needs no assumption about
 * where — or whether — the user has installed Node system-wide at all.
 * Verified against the real SDK under the exact crippled PATH above: the
 * default throws `ENOENT`; passing `executable: process.execPath` succeeds.
 *
 * Inside Electron, `process.execPath` names the Electron binary itself, not a
 * plain Node executable — spawning it as-is would try to launch a second
 * Electron/Chromium instance. `ELECTRON_RUN_AS_NODE=1` is Electron's own
 * documented mechanism for exactly this: it makes the SAME binary behave as a
 * plain Node interpreter for that one process, running whatever script it is
 * given as argv instead of loading app code. Verified directly: the packaged
 * `.app`'s own executable, run with that flag and a one-line script, printed
 * `process.version` and exited — no window, no app, just Node. On the hosted
 * server `process.execPath` already IS a plain Node binary (the Docker image
 * is `FROM node:22-slim`), so the flag is simply never inspected there — it
 * has no effect on a non-Electron Node process.
 */

/** The exact path to hand the SDK as its `executable` option — a plain
 *  wrapper so call sites read as intent ("run the agent as THIS process's own
 *  runtime") rather than a bare, unexplained `process.execPath`. Injectable
 *  for tests, the same seam pattern `fleet.ts`'s `nextId` and `totalMemBytes`
 *  already use. */
export function agentExecutablePath(execPath: string = process.execPath): string {
  return execPath;
}

/**
 * `NodeJS.ProcessVersions` (Node's own ambient type) does not declare an
 * `electron` field at all — Electron adds it at runtime, not in this
 * package's type graph, which has no dependency on Electron's types. This is
 * the real, minimal shape this function actually reads, named so a caller
 * sees what is being asked rather than an unexplained inline object type.
 */
export interface RuntimeVersions {
  // Explicit `| undefined` (not just `?`) because this package builds with
  // `exactOptionalPropertyTypes`, under which an optional field means "may be
  // absent", not "may be `undefined`" — and a test naming the absent case
  // explicitly (`{ electron: undefined }`) is clearer than omitting the key.
  readonly electron?: string | undefined;
}

/**
 * The env addition that makes `agentExecutablePath()` actually work when the
 * caller is Electron — a no-op object everywhere else. `versions.electron` is
 * `undefined` on every plain Node process (the hosted server, every test),
 * and set to a version string only inside Electron's own process, main or
 * renderer alike.
 *
 * `process.versions` genuinely has no `electron` field in this package's own
 * type graph (`NodeJS.ProcessVersions`, with no dependency on Electron's
 * types to augment it) — TypeScript's weak-type check refuses a direct
 * assignment between two object types with no declared property in common,
 * even though the real object simply carries the field or does not, at
 * runtime, regardless of what its static type says. The `unknown` step is
 * what that check is actually for: an honest "this is wider than its type
 * says," not a way around a real mismatch.
 */
export function electronRunAsNodeEnv(
  versions: RuntimeVersions = process.versions as unknown as RuntimeVersions,
): Record<string, string> {
  return versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' };
}
