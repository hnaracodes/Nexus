/**
 * GitHub App authentication (plan phase-6).
 *
 * Nexus authenticates to GitHub as an *App*, never as a human holding a pasted
 * token. The human authorizes once; from then on this module mints the
 * short-lived credentials each operation needs, from the App private key. That
 * is what makes the hard requirement achievable — after one authorize click the
 * human never supplies a GitHub credential again, including after a restart,
 * because the only thing we persist (`installationId`) is not a secret.
 *
 * Two properties in here are load-bearing and must not be softened:
 *
 *  1. **The App secrets are deleted from `process.env` at import.** See below.
 *  2. **A repository binding is never taken from the browser.** GitHub's own
 *     docs warn the setup redirect can be hit with a spoofed `installation_id`,
 *     so every binding is resolved out of a list this server fetched with the
 *     user's own token. See `findVerifiedRepo`.
 */

import { createHash, createSign, randomBytes, randomUUID } from 'node:crypto';

const GITHUB_API = 'https://api.github.com';
const GITHUB_WEB = 'https://github.com';

export interface GithubAppConfig {
  clientId: string;
  clientSecret: string;
  privateKeyPem: string;
}

/** Injection seam so every test runs without touching the network. */
export interface GithubDeps {
  fetch?: typeof fetch;
}

/** A resolved, verified repository binding. None of this is secret — all four
 *  fields are safe to persist in the room's meta sidecar and to show a client. */
export interface GithubBinding {
  installationId: number;
  owner: string;
  repo: string;
  defaultBranch: string;
}

export interface VerifiedRepo {
  owner: string;
  repo: string;
  defaultBranch: string;
  private: boolean;
}

export interface VerifiedInstallation {
  installationId: number;
  account: string;
  repositories: VerifiedRepo[];
}

/**
 * Read the App secrets, then remove them from `process.env` — before any room
 * can attach an agent.
 *
 * `startAgent` spawns the SDK subprocess with `env: { ...process.env, ... }`,
 * so every server-wide environment variable is inherited by an agent that
 * participants can ask to run `printenv`. Nexus previously had only *per-room*
 * secrets, which made that harmless. The App private key is the first
 * server-wide one, and it is a master key: it mints installation tokens for
 * EVERY installation, so a participant in any room could reach every user's
 * repositories.
 *
 * Deleting here rather than filtering in agent.ts is deliberate — an incomplete
 * allowlist would break the SDK subprocess, which needs PATH, HOME and on
 * Windows SystemRoot/APPDATA, and that path is already verified working.
 *
 * `GITHUB_APP_CLIENT_ID` deliberately stays: it is public, and appears in every
 * authorize URL anyway.
 *
 * NOTE FOR CALLERS: `src/server/index.ts` imports this module **statically** so
 * this runs at boot. A lazy `await import()` inside a route handler would leave
 * the secrets in the environment until the first GitHub request. The import
 * looks removable. It is not.
 */
function loadConfigAndScrubEnv(): GithubAppConfig | null {
  const clientId = process.env['GITHUB_APP_CLIENT_ID'];
  const clientSecret = process.env['GITHUB_APP_CLIENT_SECRET'];
  const privateKeyB64 = process.env['GITHUB_APP_PRIVATE_KEY_B64'];

  // Unconditional, and before the completeness check below: a half-configured
  // deployment must still not leave a private key where the agent can read it.
  delete process.env['GITHUB_APP_CLIENT_SECRET'];
  delete process.env['GITHUB_APP_PRIVATE_KEY_B64'];

  if (
    clientId === undefined ||
    clientId === '' ||
    clientSecret === undefined ||
    clientSecret === '' ||
    privateKeyB64 === undefined ||
    privateKeyB64 === ''
  ) {
    return null;
  }

  // Base64 so a multi-line PEM survives being set as one env var / Fly secret.
  const privateKeyPem = Buffer.from(privateKeyB64, 'base64').toString('utf8');
  return { clientId, clientSecret, privateKeyPem };
}

let config: GithubAppConfig | null = loadConfigAndScrubEnv();

/**
 * Assert that nothing secret-looking survived the scrub. Generic on purpose:
 * the `delete` above fixes the two secrets that exist today, but the underlying
 * fragility — agent.ts forwarding the whole environment — remains for whatever
 * secret someone adds next. Returns the offending names rather than throwing so
 * the caller decides whether that is fatal.
 */
export function findLeakedEnvSecrets(): string[] {
  const suspicious = /SECRET|PRIVATE_KEY|_TOKEN$/i;
  // Legitimately non-secret names that would otherwise trip the pattern.
  const allowed = new Set(['NEXUS_CLIENT_DIR']);
  return Object.keys(process.env).filter((name) => suspicious.test(name) && !allowed.has(name));
}

export function hasGithubAppConfig(): boolean {
  return config !== null;
}

export function getGithubAppConfig(): GithubAppConfig {
  if (config === null) {
    throw new Error('GitHub App is not configured on this server.');
  }
  return config;
}

/** Test-only. Never call from server code. */
export function __setGithubAppConfig(next: GithubAppConfig | null): void {
  config = next;
}

// --- App JWT ----------------------------------------------------------------

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/**
 * A short-lived RS256 assertion proving we hold the App private key. Used only
 * to mint installation tokens — never sent to git, never given to the agent.
 *
 * No dependency needed: node:crypto signs this in three lines. `iat` is backed
 * off 60s because GitHub rejects a JWT whose `iat` is in the future by ITS
 * clock, and a container's clock drifts.
 */
export function mintAppJwt(now: number = Date.now()): string {
  const cfg = getGithubAppConfig();
  const iat = Math.floor(now / 1000) - 60;
  const exp = iat + 540; // ≤ 10 minutes from now even after the 60s backdate.
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat, exp, iss: cfg.clientId }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256').update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(cfg.privateKeyPem).toString('base64url')}`;
}

// --- HTTP -------------------------------------------------------------------

/**
 * Every GitHub call goes through here so no call site can forget the version
 * header — or, more importantly, so no call site can interpolate a credential
 * into a thrown error. The message carries a status code and nothing else:
 * these errors reach `agent_error`, which is logged AND broadcast.
 */
async function githubJson(
  url: string,
  init: RequestInit,
  deps: GithubDeps | undefined,
  what: string,
): Promise<unknown> {
  const doFetch = deps?.fetch ?? fetch;
  const response = await doFetch(url, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'nexus',
      'x-github-api-version': '2022-11-28',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub rejected the request to ${what} (HTTP ${response.status}).`);
  }
  return (await response.json()) as unknown;
}

// --- Installation tokens ----------------------------------------------------

export interface TokenScope {
  /** Repository NAMES, not full names. Mutually exclusive with repository_ids. */
  repositories: string[];
  permissions: Record<string, 'read' | 'write'>;
}

/**
 * Mint a 1-hour installation token, narrowed to the given repositories and
 * permissions. Narrowing is per mint, which is the whole reason an App beats a
 * pasted token: the credential that reaches `git` can be read-only on one repo
 * even though the installation itself may allow more.
 */
export async function mintInstallationToken(
  installationId: number,
  scope: TokenScope,
  deps?: GithubDeps,
): Promise<string> {
  const body = await githubJson(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${mintAppJwt()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ repositories: scope.repositories, permissions: scope.permissions }),
    },
    deps,
    'mint an installation token',
  );
  const token = (body as { token?: unknown }).token;
  if (typeof token !== 'string') {
    throw new Error('GitHub returned no installation token.');
  }
  return token;
}

/**
 * Asymmetric scoping, deliberately. The clone token is handed to a `git`
 * subprocess whose environment a participant can in principle read, so it is
 * read-only on exactly one repository. The publish token can write — and never
 * touches a subprocess, only a `fetch` Authorization header.
 */
export async function mintCloneToken(binding: GithubBinding, deps?: GithubDeps): Promise<string> {
  return mintInstallationToken(
    binding.installationId,
    { repositories: [binding.repo], permissions: { contents: 'read' } },
    deps,
  );
}

export async function mintPublishToken(binding: GithubBinding, deps?: GithubDeps): Promise<string> {
  return mintInstallationToken(
    binding.installationId,
    { repositories: [binding.repo], permissions: { contents: 'write', pull_requests: 'write' } },
    deps,
  );
}

// --- OAuth (user-to-server) -------------------------------------------------

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * `state` is the load-bearing CSRF defence here, not PKCE: this is a
 * confidential client — the exchange happens server-side with a client secret
 * the browser never sees. `code_challenge` is sent as defence in depth and
 * costs nothing if GitHub ignores it.
 */
export function buildAuthorizeUrl(opts: {
  state: string;
  codeChallenge: string;
  redirectUri: string;
}): string {
  const cfg = getGithubAppConfig();
  const url = new URL(`${GITHUB_WEB}/login/oauth/authorize`);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * Exchange the callback code for a user-to-server token. That token is used
 * once, to verify which installations genuinely belong to this human, and is
 * then discarded in the same request — Nexus never stores it.
 */
export async function exchangeCodeForUserToken(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  deps?: GithubDeps,
): Promise<string> {
  const cfg = getGithubAppConfig();
  const body = await githubJson(
    `${GITHUB_WEB}/login/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    },
    deps,
    'exchange the authorization code',
  );
  const token = (body as { access_token?: unknown }).access_token;
  if (typeof token !== 'string') {
    // GitHub answers 200 with {error: "bad_verification_code"} on failure, so
    // the !ok check above does not catch this. Never echo the body — it is a
    // response to a request that carried the client secret.
    throw new Error('GitHub did not return a user access token.');
  }
  return token;
}

/**
 * What this human actually has, according to GitHub, asked with their own
 * token. This is the only source a binding may come from.
 */
export async function listUserInstallationsWithRepos(
  userToken: string,
  deps?: GithubDeps,
): Promise<VerifiedInstallation[]> {
  const headers = { authorization: `Bearer ${userToken}` };
  const listed = (await githubJson(
    `${GITHUB_API}/user/installations?per_page=100`,
    { headers },
    deps,
    'list your installations',
  )) as { installations?: { id?: number; account?: { login?: string } }[] };

  const out: VerifiedInstallation[] = [];
  for (const installation of listed.installations ?? []) {
    if (typeof installation.id !== 'number') continue;
    const repos = (await githubJson(
      `${GITHUB_API}/user/installations/${installation.id}/repositories?per_page=100`,
      { headers },
      deps,
      'list the repositories you granted',
    )) as {
      repositories?: {
        name?: string;
        default_branch?: string;
        private?: boolean;
        owner?: { login?: string };
      }[];
    };

    out.push({
      installationId: installation.id,
      account: installation.account?.login ?? '',
      repositories: (repos.repositories ?? [])
        .filter((r) => typeof r.name === 'string' && typeof r.owner?.login === 'string')
        .map((r) => ({
          owner: r.owner?.login ?? '',
          repo: r.name ?? '',
          defaultBranch: r.default_branch ?? 'main',
          private: r.private === true,
        })),
    });
  }
  return out;
}

// --- Connect sessions -------------------------------------------------------

/**
 * Two short-lived server-side stores, both in memory on purpose.
 *
 * `pending` holds the PKCE verifier between the authorize redirect and the
 * callback, keyed by the single-use `state`. `connects` holds the VERIFIED
 * installation list between the callback and room creation, keyed by an opaque
 * `connectId` the browser carries.
 *
 * Losing both on restart is correct: they only ever describe a room that does
 * not exist yet, so no already-created room is affected — which is why this
 * does not weaken the never-ask-again requirement.
 */
const PENDING_TTL_MS = 10 * 60 * 1000;
const CONNECT_TTL_MS = 30 * 60 * 1000;

interface PendingConnect {
  verifier: string;
  expiresAt: number;
}
interface ConnectSession {
  installations: VerifiedInstallation[];
  expiresAt: number;
}

const pending = new Map<string, PendingConnect>();
const connects = new Map<string, ConnectSession>();

function sweep(now: number): void {
  for (const [key, value] of pending) if (now >= value.expiresAt) pending.delete(key);
  for (const [key, value] of connects) if (now >= value.expiresAt) connects.delete(key);
}

export function beginConnect(now: number = Date.now()): {
  state: string;
  verifier: string;
  challenge: string;
} {
  sweep(now);
  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(32).toString('base64url');
  pending.set(state, { verifier, expiresAt: now + PENDING_TTL_MS });
  return { state, verifier, challenge };
}

/** Single use. A replayed callback must not be honoured twice. */
export function consumeConnectState(
  state: string,
  now: number = Date.now(),
): { verifier: string } | undefined {
  const found = pending.get(state);
  if (found === undefined) return undefined;
  pending.delete(state);
  if (now >= found.expiresAt) return undefined;
  return { verifier: found.verifier };
}

/** Store the verified list and return the opaque handle the browser carries. */
export function completeConnect(
  installations: VerifiedInstallation[],
  now: number = Date.now(),
): string {
  sweep(now);
  const connectId = `gc_${randomUUID().replaceAll('-', '')}${randomBytes(16).toString('hex')}`;
  connects.set(connectId, { installations, expiresAt: now + CONNECT_TTL_MS });
  return connectId;
}

/** Multi-use within its TTL — one authorize may reasonably open two rooms. */
export function getConnect(
  connectId: string,
  now: number = Date.now(),
): VerifiedInstallation[] | undefined {
  const found = connects.get(connectId);
  if (found === undefined) return undefined;
  if (now >= found.expiresAt) {
    connects.delete(connectId);
    return undefined;
  }
  return found.installations;
}

/**
 * Resolve `{owner, repo}` to a full binding, or undefined.
 *
 * This is the function that stops a spoofed `installation_id`. The caller
 * passes only what the browser claims it picked; `installationId` and
 * `defaultBranch` come out of the server-side verified list, never out of the
 * request. A repository the human did not actually grant resolves to nothing,
 * and the room is never created.
 */
export function findVerifiedRepo(
  connectId: string,
  owner: string,
  repo: string,
  now: number = Date.now(),
): GithubBinding | undefined {
  for (const installation of getConnect(connectId, now) ?? []) {
    for (const candidate of installation.repositories) {
      if (candidate.owner === owner && candidate.repo === repo) {
        return {
          installationId: installation.installationId,
          owner: candidate.owner,
          repo: candidate.repo,
          defaultBranch: candidate.defaultBranch,
        };
      }
    }
  }
  return undefined;
}

/** Test-only. Never call from server code. */
export function __resetConnectSessions(): void {
  pending.clear();
  connects.clear();
}
