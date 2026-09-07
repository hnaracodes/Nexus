/**
 * GitHub sign-in (plan phase 13, unit G1).
 *
 * D1, and it is not negotiable: an account says WHO YOU ARE, never whether
 * you may enter. The room token stays the credential; guests still join by
 * link, and that is a supported way to be in a room, not a degraded one.
 * Nothing in this module gates joining — it only turns a completed GitHub
 * OAuth round trip into a public identity (`login` + avatar URL) that a
 * caller may *optionally* attach to a `participant_joined` event or a saved
 * config. See `identityToParticipantFields` for the guest-path guarantee.
 *
 * This reuses the SAME GitHub App `github.ts` already holds credentials for,
 * rather than standing up a second OAuth client. "Sign in with a GitHub App"
 * is the identical `/login/oauth/authorize` + `/login/oauth/access_token`
 * exchange `github.ts` already performs for the repo-connect flow (see its
 * OAuth section) — the difference is what the resulting user token is used
 * for once: here, one call to `GET /user` for a login and an avatar, then the
 * token is discarded. Reusing the App means this module never reads a second
 * server-wide secret out of `process.env`, so there is nothing new for it to
 * forget to delete. `github.ts` reads the App's `clientSecret` and deletes it
 * from `process.env` at module-evaluation time, and because this module
 * imports `github.ts` STATICALLY (not a lazy `await import()` inside a route
 * handler), merely importing `oauth.ts` is enough to trigger that scrub — see
 * `oauth.test.ts`'s "module-import secret scrub" suite, which asserts this
 * from this module's own entry point rather than trusting `github.ts`'s test
 * to cover it by proxy.
 *
 * The user-to-server token this module obtains is used once and never
 * stored, logged, or returned: `completeSignIn` resolves to a `GithubIdentity`
 * (login + avatar URL, both public handles GitHub shows on any profile page)
 * and nothing else. Holding to that is I4 applied to a second credential type
 * — the room's Anthropic key is the other one this codebase already protects
 * the same way.
 */

import { randomBytes } from 'node:crypto';
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCodeForUserToken,
  hasGithubAppConfig,
  type GithubDeps,
} from './github.js';

const GITHUB_API = 'https://api.github.com';

/**
 * What a signed-in participant is allowed to be known by. Both fields are
 * public on GitHub's own profile pages, so both are safe in a shareable event
 * log — see `ParticipantJoined.githubLogin`/`avatarUrl` in the protocol.
 */
export interface GithubIdentity {
  login: string;
  avatarUrl: string | null;
}

export function isSignInAvailable(): boolean {
  return hasGithubAppConfig();
}

// --- CSRF state --------------------------------------------------------------

/**
 * Single-use, server-side, keyed by `state` — the same shape as `github.ts`'s
 * `pending` map for the repo-connect flow, and deliberately NOT the same map:
 * that one is scoped to "a room is about to be created against a verified
 * repo"; this one is scoped to "a human is proving which GitHub account they
 * are", a concern with its own lifetime that has nothing to do with rooms.
 * Both existing only in memory is correct for the same reason `github.ts`'s
 * are: a lost pending sign-in on restart describes no account and no room
 * that exists yet, so nothing already created is affected.
 */
const SIGN_IN_STATE_TTL_MS = 10 * 60 * 1000;

interface PendingSignIn {
  verifier: string;
  expiresAt: number;
}

const pendingSignIns = new Map<string, PendingSignIn>();

function sweep(now: number): void {
  for (const [key, value] of pendingSignIns) {
    if (now >= value.expiresAt) pendingSignIns.delete(key);
  }
}

/**
 * Start a sign-in: mint a single-use `state` (the CSRF defence — an OAuth
 * callback with no `state`, or one that does not match anything pending, is
 * refused by `consumeSignInState`/`completeSignIn` below) and hand back the
 * URL to redirect the browser to.
 */
export function beginSignIn(
  redirectUri: string,
  now: number = Date.now(),
): { url: string; state: string } {
  sweep(now);
  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(32).toString('base64url');
  pendingSignIns.set(state, { verifier, expiresAt: now + SIGN_IN_STATE_TTL_MS });
  const url = buildAuthorizeUrl({ state, codeChallenge: challenge, redirectUri });
  return { url, state };
}

/**
 * Verify and consume a `state` exactly once. Returns `undefined` for a
 * missing, forged/mismatched, already-used, or expired state — every one of
 * those is CSRF or a replay, and none of them get a different code path.
 * Deletes on lookup regardless of expiry, so an attacker cannot distinguish
 * "expired" from "never issued" by timing a second attempt.
 */
export function consumeSignInState(
  state: string,
  now: number = Date.now(),
): { verifier: string } | undefined {
  sweep(now);
  const found = pendingSignIns.get(state);
  if (found === undefined) return undefined;
  pendingSignIns.delete(state);
  if (now >= found.expiresAt) return undefined;
  return { verifier: found.verifier };
}

// --- Completing the callback --------------------------------------------------

export interface CompleteSignInParams {
  state: string;
  code: string;
  redirectUri: string;
}

/**
 * Every call into this is a one-shot OAuth callback, so unlike
 * `findVerifiedRepo` in `github.ts` (which returns `undefined` for "try a
 * different repo") a bad `state` here THROWS: there is no retry that makes a
 * forged or replayed callback legitimate, and a caller that forgot to check a
 * boolean must not silently proceed to exchange a code for a token.
 */
export async function completeSignIn(
  params: CompleteSignInParams,
  deps?: GithubDeps,
  now: number = Date.now(),
): Promise<GithubIdentity> {
  const consumed = consumeSignInState(params.state, now);
  if (consumed === undefined) {
    throw new Error(
      'This sign-in link is missing its state, or the state has already been used or has expired.',
    );
  }
  const userToken = await exchangeCodeForUserToken(
    params.code,
    consumed.verifier,
    params.redirectUri,
    deps,
  );
  return fetchGithubIdentity(userToken, deps);
}

/**
 * The one call this module makes with the user token before discarding it.
 * `/user` requires only that the token be valid — no repository permission is
 * needed for a user's own public profile — so this works whether or not the
 * signing-in human has installed the App on anything.
 */
export async function fetchGithubIdentity(
  userToken: string,
  deps?: GithubDeps,
): Promise<GithubIdentity> {
  const doFetch = deps?.fetch ?? fetch;
  const response = await doFetch(`${GITHUB_API}/user`, {
    headers: {
      authorization: `Bearer ${userToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'nexus',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    // Never interpolate the token into the message — this reaches
    // `agent_error`-style logging paths elsewhere in the codebase, and I4
    // applies to this token exactly as it does to the Anthropic key.
    throw new Error(`GitHub rejected the request for your profile (HTTP ${response.status}).`);
  }
  const body = (await response.json()) as { login?: unknown; avatar_url?: unknown };
  if (typeof body.login !== 'string' || body.login === '') {
    throw new Error('GitHub did not return a user login.');
  }
  return {
    login: body.login,
    avatarUrl: typeof body.avatar_url === 'string' ? body.avatar_url : null,
  };
}

// --- Wiring onto the protocol -------------------------------------------------

/**
 * The guest-path guarantee (D1). A participant with no account passes
 * `undefined` here and gets back an object with NO keys — not
 * `{ githubLogin: undefined }` — so a caller that spreads this onto a
 * `participant_joined` payload adds nothing for a guest, exactly matching
 * "joined by link" in the protocol's own doc comment. Nothing upstream of
 * this function (room creation, the WS upgrade, `authorize()`) has to know
 * this module exists for that path to keep working.
 */
export function identityToParticipantFields(
  identity: GithubIdentity | undefined,
): { githubLogin?: string; avatarUrl?: string } {
  if (identity === undefined) return {};
  const fields: { githubLogin?: string; avatarUrl?: string } = { githubLogin: identity.login };
  if (identity.avatarUrl !== null) fields.avatarUrl = identity.avatarUrl;
  return fields;
}
