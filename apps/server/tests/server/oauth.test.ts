import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GitHub SIGN-IN (phase 13, G1) — identity, not admission.
 *
 * D1 is the whole point of this file: an account says who you are, never
 * whether you may enter. Every test here either proves the CSRF `state`
 * defence actually refuses a forged/replayed callback, or proves the guest
 * path (no account at all) is untouched by any of it.
 */

const SECRETS = ['GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY_B64'] as const;
const SECRET_SNAPSHOT = new Map<string, string | undefined>(
  SECRETS.map((name) => [name, process.env[name]]),
);

function restoreSecretSnapshot(): void {
  for (const [name, value] of SECRET_SNAPSHOT) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/**
 * This module never reads a GitHub App secret itself — it imports
 * `getGithubAppConfig`/`buildAuthorizeUrl`/`exchangeCodeForUserToken` from
 * `github.ts`, which already reads the App secrets and deletes them from
 * `process.env` at module-evaluation time (see its header). That is the point:
 * sign-in reuses the *same* App rather than introducing a second server-wide
 * secret this module would then be responsible for scrubbing. Proving the
 * scrub still happens when `oauth.ts` — not `github.ts`, not `index.ts` — is
 * the ENTRY POINT is what guards against someone one day inlining a fetch to
 * GitHub's OAuth endpoints here with a freshly-read env var that nobody
 * deletes.
 */
describe('module-import secret scrub', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(restoreSecretSnapshot);

  it('scrubs the App client secret from process.env merely by importing oauth.ts', async () => {
    process.env['GITHUB_APP_CLIENT_SECRET'] = 'test-client-secret';
    process.env['GITHUB_APP_PRIVATE_KEY_B64'] = Buffer.from(
      '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----\n',
    ).toString('base64');

    // No call into the module, no route handler — the import alone must be
    // enough, and it must happen synchronously during evaluation.
    await import('../../src/server/oauth.js');

    for (const name of SECRETS) {
      expect(process.env[name], `${name} survived import of oauth.ts`).toBeUndefined();
    }
  });
});

// The rest of the suite exercises the module's own state machine, which
// GithubDeps lets us test without a network. Imported once, normally — the
// scrub above already proved importing it is safe at any point.
const {
  beginSignIn,
  completeSignIn,
  consumeSignInState,
  fetchGithubIdentity,
  identityToParticipantFields,
  isSignInAvailable,
} = await import('../../src/server/oauth.js');
const { __setGithubAppConfig } = await import('../../src/server/github.js');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Records every call so tests can assert on URL, method and headers. */
function recordingFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const recorded = { url: String(url), init: init ?? {} };
    calls.push(recorded);
    return handler(recorded.url, recorded.init);
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

const REDIRECT_URI = 'https://nexus.example/api/auth/github/callback';

beforeEach(() => {
  __setGithubAppConfig({
    clientId: 'Iv1.testclientid',
    clientSecret: 's3cr3t',
    privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----\n',
  });
});
afterEach(() => __setGithubAppConfig(null));

describe('isSignInAvailable', () => {
  it('tracks whether the GitHub App is configured', () => {
    expect(isSignInAvailable()).toBe(true);
    __setGithubAppConfig(null);
    expect(isSignInAvailable()).toBe(false);
  });
});

describe('beginSignIn', () => {
  it('issues a fresh state each call and points the URL at the redirect uri', () => {
    const first = beginSignIn(REDIRECT_URI);
    const second = beginSignIn(REDIRECT_URI);
    expect(first.state).not.toBe(second.state);

    const url = new URL(first.url);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('state')).toBe(first.state);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
  });
});

describe('consumeSignInState — single use', () => {
  it('accepts a state exactly once', () => {
    const { state } = beginSignIn(REDIRECT_URI);
    expect(consumeSignInState(state)).toBeDefined();
    // A replayed callback must not be honoured a second time.
    expect(consumeSignInState(state)).toBeUndefined();
  });

  it('refuses a state it never issued (forged or mismatched)', () => {
    expect(consumeSignInState('never-issued')).toBeUndefined();
  });

  it('refuses a state past its TTL', () => {
    const start = 1_800_000_000_000;
    const { state } = beginSignIn(REDIRECT_URI, start);
    expect(consumeSignInState(state, start + 11 * 60 * 1000)).toBeUndefined();
  });
});

describe('completeSignIn', () => {
  it('exchanges the code and returns a public identity — no token anywhere in it', async () => {
    const { state } = beginSignIn(REDIRECT_URI);
    const { fetch } = recordingFetch((url) => {
      if (url === 'https://github.com/login/oauth/access_token') {
        return jsonResponse({ access_token: 'ghu_usertoken' });
      }
      if (url === 'https://api.github.com/user') {
        return jsonResponse({ login: 'octocat', avatar_url: 'https://avatars/octocat.png' });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    const identity = await completeSignIn({ state, code: 'abc123', redirectUri: REDIRECT_URI }, {
      fetch,
    });

    expect(identity).toEqual({ login: 'octocat', avatarUrl: 'https://avatars/octocat.png' });
    // Exact key set — a stray `token`/`access_token` field here would be I4's
    // exact failure mode: a secret riding along on a payload nobody scrubs.
    expect(Object.keys(identity).sort()).toEqual(['avatarUrl', 'login']);
  });

  it('refuses a callback with a missing state', async () => {
    await expect(
      completeSignIn({ state: '', code: 'abc123', redirectUri: REDIRECT_URI }),
    ).rejects.toThrow(/state/i);
  });

  it('refuses a callback whose state does not match anything pending', async () => {
    await expect(
      completeSignIn({ state: 'forged-state', code: 'abc123', redirectUri: REDIRECT_URI }),
    ).rejects.toThrow(/state/i);
  });

  it('refuses a replayed state — consumed once, second use refused', async () => {
    const { state } = beginSignIn(REDIRECT_URI);
    const { fetch } = recordingFetch((url) =>
      url === 'https://github.com/login/oauth/access_token'
        ? jsonResponse({ access_token: 'ghu_usertoken' })
        : jsonResponse({ login: 'octocat', avatar_url: 'https://avatars/octocat.png' }),
    );

    await completeSignIn({ state, code: 'abc123', redirectUri: REDIRECT_URI }, { fetch });
    await expect(
      completeSignIn({ state, code: 'abc123', redirectUri: REDIRECT_URI }, { fetch }),
    ).rejects.toThrow(/state/i);
  });

  it('never lets the user token surface in a thrown error when the profile fetch fails', async () => {
    const { state } = beginSignIn(REDIRECT_URI);
    const { fetch } = recordingFetch((url) =>
      url === 'https://github.com/login/oauth/access_token'
        ? jsonResponse({ access_token: 'ghu_secrettoken' })
        : jsonResponse({ message: 'Bad credentials' }, 401),
    );

    await expect(
      completeSignIn({ state, code: 'abc123', redirectUri: REDIRECT_URI }, { fetch }),
    ).rejects.not.toThrow(/ghu_secrettoken/);
  });
});

describe('fetchGithubIdentity', () => {
  it('sends the user token as a bearer header and maps the response', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ login: 'hubot', avatar_url: 'https://avatars/hubot.png' }),
    );
    const identity = await fetchGithubIdentity('ghu_usertoken', { fetch });
    expect(identity).toEqual({ login: 'hubot', avatarUrl: 'https://avatars/hubot.png' });
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer ghu_usertoken',
    );
  });
});

/**
 * The guest-path guarantee (D1). Nothing in this module is on the critical
 * path for joining a room — a guest who joins by link never calls anything
 * above, and the shape this module hands to `participant_joined` degrades to
 * "no fields at all" rather than a placeholder that could be mistaken for a
 * failed lookup.
 */
describe('identityToParticipantFields — the guest-path guarantee', () => {
  it('produces no fields at all for a participant with no account', () => {
    expect(identityToParticipantFields(undefined)).toEqual({});
    expect(Object.keys(identityToParticipantFields(undefined))).toHaveLength(0);
  });

  it('maps a real identity onto the protocol field names', () => {
    expect(
      identityToParticipantFields({ login: 'octocat', avatarUrl: 'https://avatars/octocat.png' }),
    ).toEqual({ githubLogin: 'octocat', avatarUrl: 'https://avatars/octocat.png' });
  });

  it('omits avatarUrl rather than sending null when GitHub has none', () => {
    const fields = identityToParticipantFields({ login: 'octocat', avatarUrl: null });
    expect(fields).toEqual({ githubLogin: 'octocat' });
    expect('avatarUrl' in fields).toBe(false);
  });
});
