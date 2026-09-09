/**
 * The minimal environment for the agent subprocess (phase 15).
 *
 * The hole (CLAUDE.md §11, open since phase 0): `startAgent` spawns the SDK
 * subprocess with `env: { ...process.env, ANTHROPIC_API_KEY: ... }` — the
 * ENTIRE server environment. A room participant can ask the agent to run
 * `printenv` and read back every secret the server process holds, whether or
 * not that secret has anything to do with running an agent. The existing
 * mitigation, `github.ts`'s `loadConfigAndScrubEnv` + `findLeakedEnvSecrets`,
 * only catches secrets someone remembered to `delete` or whose name matches
 * `/SECRET|PRIVATE_KEY|_TOKEN$/i` — a real fix for the two names it knows
 * about, but silent about the next deployment secret, which by definition
 * matches no pattern written down today.
 *
 * ALLOW-LIST, NOT A DENY-LIST. A deny-list is exactly what
 * `findLeakedEnvSecrets()` already does, and only as a WARNING — it can only
 * ever flag names matching a regex somebody wrote down in advance. Whatever
 * secret the next deployment adds (a novel key, a webhook secret with no
 * `_TOKEN` suffix, a connection string under some other name) will not match
 * that regex and will sail through a deny-list unnoticed. An allow-list
 * inverts the failure mode: an unrecognised name is dropped by default, so
 * the mistake a future deploy can make is "the agent can't find a tool it
 * needs" (loud, breaks immediately, gets noticed) rather than "the agent can
 * read a secret nobody thought to deny" (silent, gets noticed by an attacker
 * first).
 *
 * WHAT THIS DOES NOT FIX. This narrows a blast radius; it is not a jail:
 *  - An agent can still read a secret out of a FILE the room's working tree
 *    can see (a committed `.env`, a mounted credential) — keeping the agent
 *    off the filesystem it shouldn't touch is `sandbox.ts`'s job, not this
 *    one's.
 *  - `PATH` still resolves to the real system binaries, so the agent can still
 *    run `curl`, `git`, `printenv` etc. — this only stops the *server's own*
 *    environment from being handed to it on a silver plate.
 */

/**
 * Platform-neutral basics a coding agent's subprocess and the tools it shells
 * out to (git, npm, a language runtime) need to resolve binaries, find a home
 * directory for config/cache, and format output sanely. None of these are
 * secrets — they are the same values a `printenv` from the agent would have
 * revealed anyway, whether inherited from the OS or not.
 */
const ALLOWED_NAMES: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'LANG',
  'TZ',
  'TMPDIR',
  'TERM',
  // Windows equivalents of the above (no bare POSIX name covers these).
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
]);

/**
 * `LC_*` is a family, not a single name (`LC_ALL`, `LC_CTYPE`, `LC_TIME`, …),
 * so it needs a prefix check rather than a literal entry in `ALLOWED_NAMES`.
 */
function isLocaleName(name: string): boolean {
  return name.startsWith('LC_');
}

/**
 * Build the environment for one agent subprocess from the server's own
 * `process.env`, plus the provider key this specific agent gets.
 *
 * The key is a required, explicit argument rather than something read out of
 * `source` by a fixed name — the caller must say which key this agent gets,
 * so a key present in `source` under some other name (a second provider's key
 * sitting unused in the server's environment) is never handed to an agent
 * that never asked for it. `agent.ts` passes `room.getApiKey()` here as it
 * already does today; this function does not change which key that is, only
 * what else travels alongside it.
 *
 * Returns a fresh object. `source` (in practice `process.env`) is never
 * mutated — unlike `github.ts`'s `loadConfigAndScrubEnv`, which deletes from
 * `process.env` because THAT secret must not exist in the environment of any
 * subprocess anyone spawns later. This function instead controls the one
 * subprocess it is building the environment for; mutating the server's own
 * `process.env` here would be a much larger blast radius for no gain.
 */
export function buildAgentEnv(source: NodeJS.ProcessEnv, apiKey: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ALLOWED_NAMES.has(name) || isLocaleName(name)) {
      env[name] = value;
    }
  }
  env['ANTHROPIC_API_KEY'] = apiKey;
  return env;
}
