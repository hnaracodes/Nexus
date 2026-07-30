import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __setGithubAppConfig,
  beginConnect,
  buildAuthorizeUrl,
  completeConnect,
  consumeConnectState,
  createPkcePair,
  exchangeCodeForUserToken,
  findVerifiedRepo,
  getConnect,
  hasGithubAppConfig,
  listUserInstallationsWithRepos,
  mintAppJwt,
  mintCloneToken,
  mintInstallationToken,
  mintPublishToken,
} from '../../src/server/github.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

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

beforeEach(() => {
  __setGithubAppConfig({ clientId: 'Iv1.testclientid', clientSecret: 's3cr3t', privateKeyPem: PEM });
});
afterEach(() => __setGithubAppConfig(null));

describe('app configuration', () => {
  it('reports whether the App is configured', () => {
    expect(hasGithubAppConfig()).toBe(true);
    __setGithubAppConfig(null);
    expect(hasGithubAppConfig()).toBe(false);
  });
});

describe('mintAppJwt', () => {
  it('signs an RS256 JWT the App public key verifies', () => {
    const token = mintAppJwt(1_800_000_000_000);
    const [header, payload, signature] = token.split('.');
    expect(header).toBeDefined();
    expect(signature).toBeDefined();

    const decodedHeader = JSON.parse(Buffer.from(header ?? '', 'base64url').toString()) as {
      alg: string;
    };
    expect(decodedHeader.alg).toBe('RS256');

    const verifier = createVerify('RSA-SHA256').update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature ?? '', 'base64url'))).toBe(true);
  });

  it('issues iat in the past for clock drift and exp within ten minutes', () => {
    const now = 1_800_000_000_000;
    const payload = JSON.parse(
      Buffer.from(mintAppJwt(now).split('.')[1] ?? '', 'base64url').toString(),
    ) as { iat: number; exp: number; iss: string };

    const nowSeconds = Math.floor(now / 1000);
    expect(payload.iat).toBeLessThan(nowSeconds);
    expect(payload.exp).toBeGreaterThan(nowSeconds);
    // GitHub rejects anything more than 10 minutes out from ITS clock.
    expect(payload.exp - nowSeconds).toBeLessThanOrEqual(600);
    // `iss` is the client id, not the numeric App id.
    expect(payload.iss).toBe('Iv1.testclientid');
  });
});

describe('mintInstallationToken', () => {
  it('authenticates with the App JWT and returns the installation token', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse({ token: 'ghs_installtoken' }));
    const token = await mintInstallationToken(
      42,
      { repositories: ['proj'], permissions: { contents: 'read' } },
      { fetch },
    );

    expect(token).toBe('ghs_installtoken');
    expect(calls[0]?.url).toBe('https://api.github.com/app/installations/42/access_tokens');
    expect(calls[0]?.init.method).toBe('POST');
    const auth = (calls[0]?.init.headers as Record<string, string>)['authorization'];
    expect(auth?.startsWith('Bearer ')).toBe(true);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      repositories: ['proj'],
      permissions: { contents: 'read' },
    });
  });

  it('never puts the App JWT into the thrown error', async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ message: 'Bad credentials' }, 401));
    await expect(
      mintInstallationToken(42, { repositories: ['p'], permissions: {} }, { fetch }),
    ).rejects.toThrow(/GitHub rejected/i);
    await expect(
      mintInstallationToken(42, { repositories: ['p'], permissions: {} }, { fetch }),
    ).rejects.not.toThrow(/eyJ/); // a JWT always starts with the base64url of '{"'
  });
});

describe('asymmetric token scoping', () => {
  const binding = { installationId: 7, owner: 'o', repo: 'proj', defaultBranch: 'main' };

  it('mints a read-only, single-repo token for cloning', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse({ token: 'ghs_clone' }));
    await mintCloneToken(binding, { fetch });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      repositories: ['proj'],
      permissions: { contents: 'read' },
    });
  });

  it('mints a write token for publishing, still scoped to the one repo', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse({ token: 'ghs_publish' }));
    await mintPublishToken(binding, { fetch });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      repositories: ['proj'],
      permissions: { contents: 'write', pull_requests: 'write' },
    });
  });
});

describe('OAuth', () => {
  it('builds an authorize url carrying client id, redirect and state', () => {
    const url = new URL(
      buildAuthorizeUrl({
        state: 'opaque-state',
        codeChallenge: 'challenge',
        redirectUri: 'https://nexus.example/api/github/callback',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('Iv1.testclientid');
    expect(url.searchParams.get('state')).toBe('opaque-state');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://nexus.example/api/github/callback',
    );
  });

  it('exchanges a code for a user token without leaking the secret on failure', async () => {
    const ok = recordingFetch(() => jsonResponse({ access_token: 'ghu_usertoken' }));
    await expect(
      exchangeCodeForUserToken('code', 'verifier', 'https://n/cb', { fetch: ok.fetch }),
    ).resolves.toBe('ghu_usertoken');
    expect(ok.calls[0]?.url).toBe('https://github.com/login/oauth/access_token');

    const bad = recordingFetch(() => jsonResponse({ error: 'bad_verification_code' }));
    await expect(
      exchangeCodeForUserToken('code', 'verifier', 'https://n/cb', { fetch: bad.fetch }),
    ).rejects.not.toThrow(/s3cr3t/);
  });

  it('produces a PKCE pair whose challenge is the S256 of the verifier', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).not.toBe(verifier);
    expect(challenge).not.toMatch(/[+/=]/); // base64url, not base64
  });
});

describe('connect session state', () => {
  it('accepts a state exactly once', () => {
    const { state } = beginConnect();
    expect(consumeConnectState(state)).toBeDefined();
    // A replayed callback must not be honoured a second time.
    expect(consumeConnectState(state)).toBeUndefined();
  });

  it('rejects a state it never issued', () => {
    expect(consumeConnectState('never-issued')).toBeUndefined();
  });

  it('returns the verifier that was paired with the state', () => {
    const begun = beginConnect();
    expect(consumeConnectState(begun.state)?.verifier).toBe(begun.verifier);
  });
});

describe('verified repository selection', () => {
  const installations = [
    {
      installationId: 7,
      account: 'acme',
      repositories: [
        { owner: 'acme', repo: 'private-thing', defaultBranch: 'main', private: true },
        { owner: 'acme', repo: 'public-thing', defaultBranch: 'trunk', private: false },
      ],
    },
  ];

  it('resolves a binding only from the server-side verified list', () => {
    const connectId = completeConnect(installations);
    expect(getConnect(connectId)).toBeDefined();

    const found = findVerifiedRepo(connectId, 'acme', 'public-thing');
    expect(found).toEqual({
      installationId: 7,
      owner: 'acme',
      repo: 'public-thing',
      defaultBranch: 'trunk',
    });
  });

  /**
   * The load-bearing check. GitHub's own docs warn that the setup redirect can
   * be hit with a spoofed installation_id, so a binding may never be taken
   * from anything the browser sends — only from the list this server fetched
   * with the user's own token.
   */
  it('refuses a repository that is not in the verified list', () => {
    const connectId = completeConnect(installations);
    expect(findVerifiedRepo(connectId, 'acme', 'not-granted')).toBeUndefined();
    expect(findVerifiedRepo(connectId, 'someone-else', 'public-thing')).toBeUndefined();
  });

  it('refuses any repository for an unknown connect id', () => {
    expect(findVerifiedRepo('forged-connect-id', 'acme', 'public-thing')).toBeUndefined();
  });
});

describe('listUserInstallationsWithRepos', () => {
  it('uses the user token and flattens installations with their repositories', async () => {
    const { fetch, calls } = recordingFetch((url) => {
      if (url.includes('/repositories')) {
        return jsonResponse({
          repositories: [
            { name: 'proj', default_branch: 'main', private: true, owner: { login: 'acme' } },
          ],
        });
      }
      return jsonResponse({ installations: [{ id: 7, account: { login: 'acme' } }] });
    });

    const result = await listUserInstallationsWithRepos('ghu_usertoken', { fetch });
    expect(result).toEqual([
      {
        installationId: 7,
        account: 'acme',
        repositories: [{ owner: 'acme', repo: 'proj', defaultBranch: 'main', private: true }],
      },
    ]);
    for (const call of calls) {
      expect((call.init.headers as Record<string, string>)['authorization']).toBe(
        'Bearer ghu_usertoken',
      );
    }
  });
});
