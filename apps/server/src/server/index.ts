import type { IncomingMessage, Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createAdaptorServer } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { createTerminalRoom } from './terminals.js';
import { createRelayServer } from '../relay/relayServer.js';
import type { RelayLimits, RelayServer } from '../relay/relayServer.js';
import { RELAY_HOST_PATH, roomIdOfApiPath } from '../relay/protocol.js';
import type { PtyFactory, TerminalRoom } from './terminals.js';
// Re-exported for the desktop shell, the one caller that supplies a factory.
export type { PtyFactory, PtyProcess } from './terminals.js';
// Phase 20: the desktop's end of a web share, and the private socket its
// relayed guests arrive on. Exported here so the desktop imports one package.
export { startRelayShare, relayLink } from '../relay/hostClient.js';
export type { RelayShare, RelayShareStatus } from '../relay/hostClient.js';
export { listenForRelay } from '../relay/localListener.js';
export type { RelayListener } from '../relay/localListener.js';

/** Links that reach a desktop-hosted room from other machines (phase 20). */
export interface ShareLinks {
  web: string | null;
  lan: string[];
}
import type { GithubRepoRef } from '@syncode/protocol/events';
import { PRIMARY_AGENT_ID, PROTOCOL_VERSION } from '@syncode/protocol/events';
import { parseClientFrame } from '@syncode/protocol/wire';
import { PAGE_PATHS } from '@syncode/protocol/pages';
// STATIC import, deliberately. Evaluating github.ts is what reads the App
// secrets and DELETES them from process.env, and that has to happen before any
// room can attach an agent — startAgent spawns the SDK subprocess with
// `{...process.env}`, so anything still in the environment is readable by any
// participant who asks the agent to run `printenv`. A lazy `await import()`
// inside a route handler would leave the private key exposed until the first
// GitHub request. This import looks removable. It is not.
import {
  beginConnect,
  buildAuthorizeUrl,
  completeConnect,
  consumeConnectState,
  exchangeCodeForUserToken,
  findLeakedEnvSecrets,
  findVerifiedRepo,
  getConnect,
  hasGithubAppConfig,
  listUserInstallationsWithRepos,
} from './github.js';
import { presenceFrame } from './presence.js';
import { recoverRooms, writeRoomMeta } from './recovery.js';
import { prepareWorkspace, validateApiKeyShape, validateRepoUrl } from './create.js';
import {
  claimLocalPath,
  isLoopbackAddress,
  isLocalHostMode,
  localNonLoopbackIPv4Addresses,
  validateLocalRoomPath,
} from './localHost.js';
import { consumeRateLimit } from './rate-limit.js';
import {
  attachApiKey,
  authorize,
  createRoom,
  getRoom,
  hasApiKey,
  mintRoomId,
  roomCount,
} from './rooms.js';
import type { AgentDeps } from './agent.js';
import { attachRoom, getRuntime, resolveParticipantId, verifyParticipant } from './ws.js';
import { spawnAgent, stopAgent, fleetSnapshot } from './fleet.js';
import { securityHeaders } from './hardening.js';
import { launchCrew } from './crews.js';
import { hasCycle, startWorkflowRun } from './workflowRunner.js';
import { createRunRegistry, runKey } from './workflowRuns.js';
import { deleteConfig, deleteCrew, readConfig, readConfigs, readCrew, readCrews, saveConfig, saveCrew } from './configStore.js';
import {
  cancelAutoRelease,
  claimIfVacant,
  grantControl,
  isDriver,
  releaseControl,
  requestControl,
  scheduleAutoRelease,
} from './driver.js';
// phase-7a additions. These live here, not inside the phase-7 marker regions
// below, because ES module `import` statements must sit at module top level —
// neither marker region is at that level (one is inside createServer(), the
// other inside the WS message handler), so there is nowhere else for them to
// go. Nothing here is used outside the two marker regions.
import type { Room } from './rooms.js';
import { getGitDiff, getGitStatus } from './gitStatus.js';
import { detectGithubRepo } from './repoDetect.js';
import { WorkspacePathError, listTree, readWorkspaceFile } from './workspace.js';
import { readEnv } from './env.js';

// {apiKey, repoUrl} never needs more than a few hundred bytes. This is not
// about legitimate payloads — it stops an anonymous caller from streaming an
// arbitrarily large body at the endpoint before validation ever runs. Fixed,
// not env-tunable: there is no legitimate reason to raise it.
const CREATE_ROOM_MAX_BODY_BYTES = 16 * 1024;

// Read at call time, not frozen into a module-level const at import time —
// the driver grace window mutant (see the Phase 3 session's audit) is the
// reason: a test that sets the env var after this module has already loaded
// must still see the new value, or the "right assertion at the wrong moment"
// failure mode repeats itself here.
function createRoomRateLimit(): number {
  return Number(readEnv('ROOM_RATE_LIMIT') ?? 5);
}
function createRoomRateWindowMs(): number {
  return Number(readEnv('ROOM_RATE_WINDOW_MS') ?? 10 * 60 * 1000);
}
function maxRooms(): number {
  return Number(readEnv('MAX_ROOMS') ?? 200);
}

/** Fly sets Fly-Client-IP on proxied requests; X-Forwarded-For is the more
 *  general fallback. getConnInfo covers direct/local connections (tests,
 *  dev), where neither header is present. */
function clientIp(c: Context): string {
  const flyIp = c.req.header('Fly-Client-IP');
  if (flyIp !== undefined && flyIp !== '') return flyIp;
  const forwarded = c.req.header('X-Forwarded-For');
  if (forwarded !== undefined && forwarded !== '') return forwarded.split(',')[0]?.trim() ?? '';
  return getConnInfo(c).remote.address ?? 'unknown';
}

/**
 * The origin GitHub must redirect back to. `redirect_uri` has to match the
 * App's configured callback EXACTLY, so a deployment sets NEXUS_PUBLIC_URL
 * rather than relying on a proxied Host header.
 */
function publicOrigin(c: Context): string {
  const configured = readEnv('PUBLIC_URL');
  if (configured !== undefined && configured !== '') return configured.replace(/\/+$/, '');
  const proto = c.req.header('X-Forwarded-Proto') ?? 'http';
  return `${proto}://${c.req.header('Host') ?? 'localhost'}`;
}

function githubCallbackUrl(c: Context): string {
  return `${publicOrigin(c)}/api/github/callback`;
}

/** The data root every room-scoped store hangs off. Mirrors `recovery.ts`'s
 *  own default so a room's configs land beside its log and its meta sidecar. */
const DATA_DIR_ROOT = readEnv('DATA_DIR') ?? './data';

/**
 * One shared release lookup for the whole deployment.
 *
 * GitHub's unauthenticated limit is 60 requests an hour PER IP, and with the
 * server making the call that is 60 for every visitor combined rather than 60
 * each — the one real cost of proxying instead of fetching from the page. Five
 * minutes of cache turns a busy hour into twelve requests. A release changes
 * when someone pushes a tag, so five minutes of staleness is invisible.
 */
const RELEASE_URL = 'https://api.github.com/repos/hnaracodes/Nexus/releases/latest';
const RELEASE_CACHE_MS = 5 * 60 * 1000;
let releaseCache: { at: number; body: unknown } | null = null;

/** Clears the module-scope release cache between tests, the same way
 *  `__resetRuntimes` clears ws.ts's room memo. Without it the first test to
 *  populate the cache silently answers every later one, and an assertion about
 *  a 502 passes against a 200 it never made. */
export function __resetReleaseCache(): void {
  releaseCache = null;
}

/**
 * The room token from a request, under either header name.
 *
 * The SynCode rename moved this header, and it is a live wire contract rather
 * than copy: a browser tab that was already open when a deploy lands is still
 * running the OLD bundle and still sending `X-Nexus-Token`. A server that only
 * accepted the new name would log every one of those people out mid-session,
 * and the room link is the credential — they would have to find it again.
 *
 * So both are accepted and the new one wins. Dropping `X-Nexus-Token` is safe
 * only once no deployed bundle still sends it, which means one release after
 * every client has been served the new one.
 */
function roomTokenHeader(c: Context): string | undefined {
  return c.req.header('X-SynCode-Token') ?? c.req.header('X-Nexus-Token');
}

export function createServer(
  opts: {
    agentDeps?: AgentDeps;
    /**
     * Phase 19b. Only the desktop shell passes this. A server without it can
     * never open a terminal — the property that keeps a shell off the hosted
     * machine is construction, not a flag (see terminals.ts).
     */
    terminals?: PtyFactory;
    /**
     * Whether a socket's TCP peer address is the HOST (the person at the
     * desktop app), who alone may switch terminals on or off. Defaults to
     * `isLoopbackAddress`. Injectable because one machine cannot otherwise
     * produce a non-loopback "LAN guest" for a test.
     */
    hostPeer?: (remoteAddress: string | undefined) => boolean;
    /**
     * Phase 20. Run the web-share relay on this server: desktop hosts register
     * a room here and guests reach it through this server's ordinary room
     * link. The hosted entry point turns it on; the desktop never does.
     */
    relay?:
      | boolean
      | {
          limits?: Partial<RelayLimits>;
          /**
           * Injectable for the same reason as `hostPeer`: one test process
           * holds ONE room registry, so a desktop-shaped server and a relay in
           * the same process would otherwise see every room as "local" here.
           * Production always uses the real registry.
           */
          isLocalRoom?: (roomId: string) => boolean;
        };
  } = {},
): {
  app: Hono;
  server: Server;
  /** Phase 20 (desktop): tell the host's own sockets which links reach this room. */
  setShareLinks: (roomId: string, links: ShareLinks) => void;
  relay: RelayServer | undefined;
} {
  const app = new Hono();

  /**
   * Registered FIRST, so it covers every route including the 404s and the
   * static bundle (phase 15).
   *
   * The highest-value header here is `Referrer-Policy: no-referrer`, and it is
   * worth knowing why in this app specifically: the room URL contains the room
   * TOKEN, which is the product's entire credential (CLAUDE.md §11). A referrer
   * leaking to any third-party resource would be a room compromise, not a
   * privacy nit.
   */
  app.use('*', securityHeaders());

  // A room link is "/?room=…&token=…", and the token IS the credential. Without
  // this, following any outbound link from a room page — including the GitHub
  // authorize redirect this phase adds — hands the room token to the
  // destination in the Referer header. Registered before every route so no
  // handler can be reached without it.
  app.use('*', async (c, next) => {
    await next();
    c.header('Referrer-Policy', 'no-referrer');
  });

  // --- BEGIN phase-20 relay (HTTP) ---
  /**
   * Room-scoped API requests for a room a desktop host is sharing through this
   * relay. Registered before every room route. A LOCAL room with the id always
   * wins; otherwise a registration matching (roomId, sha256(token)) gets the
   * request; otherwise this falls through to the normal handlers unchanged.
   * `POST /api/rooms` (no id) never matches. See relay/relayServer.ts.
   */
  const relay: RelayServer | undefined =
    opts.relay === undefined || opts.relay === false
      ? undefined
      : createRelayServer({
          isLocalRoom:
            (typeof opts.relay === 'object' ? opts.relay.isLocalRoom : undefined) ??
            ((id) => getRoom(id) !== undefined),
          allowRegister: (ip) => consumeRateLimit(`relay-register:${ip}`, 20, 60_000),
          ...(typeof opts.relay === 'object' && opts.relay.limits !== undefined ? { limits: opts.relay.limits } : {}),
        });
  if (relay !== undefined) {
    app.use('/api/rooms/*', async (c, next) => {
      const roomId = roomIdOfApiPath(new URL(c.req.url).pathname);
      if (roomId === null) return next();
      const relayed = await relay.forwardHttp(roomId, roomTokenHeader(c), c.req.raw);
      if (relayed === null) return next();
      return relayed;
    });
  }
  // --- END phase-20 relay (HTTP) ---

  app.get('/healthz', (c) =>
    c.json({ ok: true, githubConnectEnabled: hasGithubAppConfig() }),
  );

  // --- BEGIN phase-6 GitHub App connect routes ---

  app.get('/api/github/status', (c) => c.json({ enabled: hasGithubAppConfig() }));

  /**
   * The desktop app's published release, fetched HERE rather than from the
   * visitor's browser.
   *
   * `/download` originally called api.github.com directly from the page. Two
   * things were wrong with that, and only one of them was visible:
   *
   *   - It never ran. `connect-src` is `'self'` plus the room websocket
   *     (hardening.ts), so the browser refused the request and the page showed
   *     its "Couldn't reach GitHub" fallback to every visitor. Third CSP
   *     regression in this project; the first one blanked the whole room.
   *   - Widening `connect-src` to allow it would have made a published promise
   *     false. `/privacy` says, in as many words, "SynCode adds no other
   *     third-party processor" beside its disclosure of Google Fonts. A fetch
   *     from the page would hand every visitor's IP to GitHub on page load.
   *     Editing that sentence to match the code is the wrong direction — the
   *     privacy page is a commitment, not a description.
   *
   * So the server makes the call and the browser only ever talks to us. The
   * CSP is unchanged and the privacy page stays true.
   *
   * Deliberately UNAUTHENTICATED: this is public marketing data about a public
   * release, reachable from a page with no room and no token.
   *
   * The response is TRIMMED rather than proxied whole. GitHub's release payload
   * carries uploader identities, node ids and a dozen URLs this page never
   * reads, and forwarding an upstream body verbatim is how fields nobody
   * reviewed end up on someone's screen.
   */
  app.get('/api/releases/latest', async (c) => {
    const cached = releaseCache;
    if (cached !== null && Date.now() - cached.at < RELEASE_CACHE_MS) {
      return c.json(cached.body);
    }
    try {
      const upstream = await fetch(RELEASE_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'syncode-download-page' },
        signal: AbortSignal.timeout(5000),
      });
      if (!upstream.ok) return c.json({ error: 'Could not reach GitHub.' }, 502);
      const raw = (await upstream.json()) as {
        tag_name?: unknown;
        html_url?: unknown;
        assets?: unknown;
      };
      const body = {
        tag_name: typeof raw.tag_name === 'string' ? raw.tag_name : '',
        html_url: typeof raw.html_url === 'string' ? raw.html_url : '',
        assets: (Array.isArray(raw.assets) ? raw.assets : [])
          .map((asset) => asset as Record<string, unknown>)
          .filter(
            (asset) =>
              typeof asset['name'] === 'string' &&
              typeof asset['browser_download_url'] === 'string' &&
              typeof asset['size'] === 'number',
          )
          .map((asset) => ({
            name: asset['name'] as string,
            browser_download_url: asset['browser_download_url'] as string,
            size: asset['size'] as number,
          })),
      };
      releaseCache = { at: Date.now(), body };
      return c.json(body);
    } catch {
      // Never echo the upstream error: it can carry a URL with a token in it if
      // this ever grows an authenticated call, and the page has its own
      // fallback anyway.
      return c.json({ error: 'Could not reach GitHub.' }, 502);
    }
  });

  app.get('/api/github/connect', (c) => {
    if (!hasGithubAppConfig()) {
      // A redirect, not a 404 body. The browser NAVIGATES here, so returning
      // JSON would drop the user out of the app onto a bare error document
      // with no way back. Reachable with a stale `?connect=` link on a server
      // where the App was never configured or has been removed.
      return c.redirect('/new?github_error=failed', 302);
    }
    const { state, challenge } = beginConnect();
    return c.redirect(
      buildAuthorizeUrl({
        state,
        codeChallenge: challenge,
        redirectUri: githubCallbackUrl(c),
      }),
      302,
    );
  });

  /**
   * The callback is the security-critical half of the flow.
   *
   * GitHub's own documentation warns that the setup/callback URL can be hit
   * with a spoofed `installation_id`, so NOTHING here is taken on the request's
   * word. The code is exchanged for a user-to-server token, that token is used
   * once to ask GitHub which installations genuinely belong to this human, and
   * is then discarded — it is never stored, never logged, never persisted.
   * Only the resulting verified list survives, behind an opaque connect id.
   */
  app.get('/api/github/callback', async (c) => {
    if (!hasGithubAppConfig()) {
      return c.json({ error: 'GitHub is not configured on this server.' }, 404);
    }
    const code = c.req.query('code') ?? '';
    // Single use: a replayed callback must not be honoured twice.
    const pending = consumeConnectState(c.req.query('state') ?? '');
    if (code === '' || pending === undefined) {
      return c.redirect('/new?github_error=expired', 302);
    }
    try {
      const userToken = await exchangeCodeForUserToken(
        code,
        pending.verifier,
        githubCallbackUrl(c),
      );
      const installations = await listUserInstallationsWithRepos(userToken);
      // `userToken` goes out of scope here and is deliberately never stored.
      return c.redirect(`/new?connect=${completeConnect(installations)}`, 302);
    } catch {
      // Never surface the raw error: it describes a request that carried the
      // client secret, and this string would reach a browser.
      return c.redirect('/new?github_error=failed', 302);
    }
  });

  app.get('/api/github/repos', (c) => {
    const installations = getConnect(c.req.query('connect') ?? '');
    if (installations === undefined) {
      return c.json({ error: 'That GitHub connection expired. Connect again.' }, 404);
    }
    return c.json({ installations });
  });

  // --- END phase-6 GitHub App connect routes ---

  app.post(
    '/api/rooms',
    bodyLimit({
      maxSize: CREATE_ROOM_MAX_BODY_BYTES,
      onError: (c) => c.json({ error: 'Request body too large.' }, 413),
    }),
    async (c) => {
      // Cheapest checks first — an anonymous caller pays as little of the
      // server's time as possible before being turned away. Cast-in-stone
      // order: rate limit → room ceiling → body validation → the actual clone.
      if (
        !consumeRateLimit(`create:${clientIp(c)}`, createRoomRateLimit(), createRoomRateWindowMs())
      ) {
        return c.json({ error: 'Too many rooms created from this address. Try again later.' }, 429);
      }
      if (roomCount() >= maxRooms()) {
        return c.json({ error: 'SynCode is at capacity. Try again later.' }, 503);
      }

      const body = (await c.req.json().catch(() => null)) as
        | {
            apiKey?: string;
            repoUrl?: string | null;
            connectId?: string;
            owner?: string;
            repo?: string;
            localPath?: string;
          }
        | null;

      const keyCheck = validateApiKeyShape(body?.apiKey);
      if (!keyCheck.ok) return c.json({ error: keyCheck.message }, 400);

      // --- BEGIN phase-17b local-folder room creation ---
      //
      // A room can BE an existing directory instead of a fresh clone — the
      // desktop shell's "open a folder" flow. This is gated on BOTH, checked
      // independently, per CLAUDE.md §11: honouring `localPath` on a hosted
      // server would be a remote arbitrary-directory read.
      //   1. isLocalHostMode() — only the desktop shell's own process sets
      //      NEXUS_LOCAL_HOST=1; fly.toml never does.
      //   2. isLoopbackAddress() on the request's OWN socket peer address —
      //      read via getConnInfo, never from a client-suppliable header.
      // A `localPath` present under a server NOT in local-host mode is
      // refused outright, not silently ignored: silently falling back to an
      // empty fresh room would look like success while handing the caller
      // something they did not ask for, which is a worse failure mode than a
      // loud 403.
      if (typeof body?.localPath === 'string' && body.localPath !== '') {
        const remoteAddress = getConnInfo(c).remote.address;
        if (!isLocalHostMode() || !isLoopbackAddress(remoteAddress)) {
          // One message for both failure causes, deliberately: this route
          // exists for exactly one caller (the desktop shell talking to its
          // own in-process server), so there is no legitimate remote caller
          // this message needs to help debug, and distinguishing the two
          // causes would only hand a remote attacker a one-bit oracle onto
          // this server's configuration for free.
          return c.json({ error: 'Local folder rooms are not available on this server.' }, 403);
        }
        if (
          (typeof body.repoUrl === 'string' && body.repoUrl !== '') ||
          (typeof body.connectId === 'string' && body.connectId !== '')
        ) {
          return c.json({ error: 'A local folder room cannot also name a repository.' }, 400);
        }

        const validated = validateLocalRoomPath(body.localPath);
        if (!validated.ok) return c.json({ error: validated.message }, 400);

        const roomId = mintRoomId();
        const cwd = validated.path;
        // Claimed BEFORE createRoom, not after: createRoom cannot itself
        // fail, so there is no ordering where claiming late would matter,
        // and claiming late here would only be a needless extra place for a
        // future edit to get the order wrong.
        claimLocalPath(cwd);
        const room = createRoom({ id: roomId, apiKey: keyCheck.apiKey, cwd, repoUrl: detectGithubRepo(cwd)?.url ?? null, github: null });
        writeRoomMeta({
          roomId: room.id,
          token: room.token,
          cwd: room.cwd,
          repoUrl: room.repoUrl,
          createdAt: room.createdAt,
          github: room.github,
        });
        attachRoom(room, undefined, opts.agentDeps);
        return c.json({ roomId: room.id, token: room.token });
      }
      // --- END phase-17b local-folder room creation ---

      // Two mutually exclusive ways to name a repository. The GitHub path wins
      // when present; a caller sending both gets the verified one, never the
      // free-text one.
      let github: GithubRepoRef | null = null;
      let repoUrl: string | null = null;

      if (typeof body?.connectId === 'string' && body.connectId !== '') {
        // THE load-bearing check. `installationId` and `defaultBranch` are read
        // out of the server-side list this server fetched with the user's own
        // token — never off the request. A caller naming a repository they did
        // not actually grant resolves to nothing and no room is created, which
        // is what stops a spoofed installation id.
        const binding = findVerifiedRepo(
          body.connectId,
          typeof body.owner === 'string' ? body.owner : '',
          typeof body.repo === 'string' ? body.repo : '',
        );
        if (binding === undefined) {
          return c.json(
            {
              error:
                'That repository is not available on your GitHub connection. Connect again and pick from the list.',
            },
            400,
          );
        }
        github = binding;
        repoUrl = `https://github.com/${binding.owner}/${binding.repo}`;
      } else {
        const repoCheck = validateRepoUrl(body?.repoUrl);
        if (!repoCheck.ok) return c.json({ error: repoCheck.message }, 400);
        repoUrl = repoCheck.url;
      }

      // Name the workspace before the room exists, because cwd is readonly and
      // the agent reads it the moment the room attaches.
      const roomId = mintRoomId();
      let cwd: string;
      try {
        cwd = await prepareWorkspace(roomId, repoUrl, undefined, github);
      } catch {
        // Never surface the raw git error — it can echo the URL and credentials.
        return c.json(
          { error: 'Could not clone that repository. Check the URL and try again.' },
          400,
        );
      }

      const room = createRoom({ id: roomId, apiKey: keyCheck.apiKey, cwd, repoUrl, github });
      writeRoomMeta({
        roomId: room.id,
        token: room.token,
        cwd: room.cwd,
        repoUrl: room.repoUrl,
        createdAt: room.createdAt,
        // Survives the restart, unlike the API key — this is what makes
        // "authorize once, ever" true.
        github: room.github,
      });
      attachRoom(room, undefined, opts.agentDeps);
      return c.json({ roomId: room.id, token: room.token });
    },
  );

  app.get('/api/rooms/:id', (c) => {
    const room = getRoom(c.req.param('id'));
    if (room === undefined) return c.json({ error: 'No such room.' }, 404);
    const token = roomTokenHeader(c);
    if (token === undefined || authorize(room.id, token) === undefined) {
      return c.json({ error: 'Invalid room token.' }, 401);
    }
    return c.json(room.toJSON());
  });

  /**
   * Phase 17b/17c: the machine's own non-loopback IPv4 addresses, so the
   * desktop shell can show a joinable LAN URL before it actually rebinds the
   * listener wide. Gated on a room token — CLAUDE.md §11: "the host's LAN
   * topology is not public" — the SAME guard as GET /api/rooms/:id above,
   * just keyed by a `?room=` query param rather than a path segment, because
   * this fact is about the HOST, not about any one room's other state.
   *
   * That token guard alone is not enough: this route's whole reason to exist
   * is telling the DESKTOP SHELL its own machine's LAN addresses, which makes
   * sense only when this process IS that shell (`isLocalHostMode()`). On an
   * ordinary hosted deployment, holding a valid token for any one room would
   * otherwise be enough to enumerate the server's network interfaces — a
   * fact about the host, not about any room the caller was invited to.
   * Checked FIRST and unconditionally, before the token, the same way
   * `/api/github/callback` refuses outright when a feature is not configured
   * on this server at all: the route does not apply here, so it 404s rather
   * than merely returning an empty list.
   */
  app.get('/api/host/addresses', (c) => {
    if (!isLocalHostMode()) {
      return c.json({ error: 'Host addresses are not available on this server.' }, 404);
    }
    const roomId = c.req.query('room') ?? '';
    const token = roomTokenHeader(c);
    if (token === undefined || authorize(roomId, token) === undefined) {
      return c.json({ error: 'Invalid room token.' }, 401);
    }
    return c.json({ addresses: localNonLoopbackIPv4Addresses() });
  });

  // --- BEGIN phase-7 workspace routes ---
  // phase-7a owns this region. Five GET routes go here:
  //   /api/rooms/:id/workspace/tree?path=   /api/rooms/:id/workspace/file?path=
  //   /api/rooms/:id/git/status             /api/rooms/:id/git/diff?path=
  //   /api/rooms/:id/models
  // Guard each exactly as GET /api/rooms/:id does above — X-SynCode-Token header (or the legacy X-Nexus-Token)
  // plus authorize(). NO query-param token fallback: only the WS upgrade needs
  // one, because the browser's WebSocket constructor cannot set headers.
  // The path is a QUERY PARAM, never a wildcard segment — Hono decodes and
  // normalizes wildcard segments before the handler sees them, and "someone
  // else already parsed this" is not what you want on a jail boundary.
  // PAGE_ROUTES stays untouched; these are API routes, and an unmatched
  // /api/* must keep 404ing rather than returning index.html.

  /** Same guard as GET /api/rooms/:id above, factored out for five call sites. */
  function requireRoom(c: Context): { room: Room } | Response {
    const room = getRoom(c.req.param('id') ?? '');
    if (room === undefined) return c.json({ error: 'No such room.' }, 404);
    const token = roomTokenHeader(c);
    if (token === undefined || authorize(room.id, token) === undefined) {
      return c.json({ error: 'Invalid room token.' }, 401);
    }
    return { room };
  }

  /** WorkspacePathError carries its own 400-vs-404 distinction; anything else
   *  is an unexpected failure, reported as a plain 500 rather than echoing a
   *  raw error (the same "never surface the raw error" discipline used
   *  elsewhere in this file). */
  function workspaceErrorResponse(c: Context, error: unknown): Response {
    if (error instanceof WorkspacePathError) {
      return c.json({ error: error.message }, error.code === 'not_found' ? 404 : 400);
    }
    return c.json({ error: 'Could not read the workspace.' }, 500);
  }

  /**
   * Where THIS room's saved configs and crews live.
   *
   * The routes below were originally guarded by `requireRoom` alone, which
   * proves the caller holds a valid token for SOME room — while the store
   * itself was process-global. A participant in room A could therefore read,
   * overwrite or delete room B's configs, and a config is executable input
   * that another room will later launch. Authentication without scoping is not
   * authorization.
   *
   * Namespacing by room id is the safe default while accounts are deferred
   * (CLAUDE.md §7). It does cost the "share a crew between rooms" half of
   * phase 13's demo bar — that is a genuine, deliberate narrowing, and sharing
   * belongs with the account identity that can express WHO may share, rather
   * than with "anyone holding any room token".
   */
  function roomScope(roomId: string): string {
    return join(DATA_DIR_ROOT, 'roomdata', roomId);
  }

  const runRegistry = createRunRegistry();
  // --- BEGIN phase-13 config + crew routes ---
  // Scoped under a room and guarded by `requireRoom`, which calls
  // `authorize()`. Configs are not strictly room state — they are user assets
  // (phase-13-crews-and-accounts.md, D3) — but the room TOKEN is the only
  // credential this system has, and CLAUDE.md §11 is explicit that the room ID
  // is not one: it is 64 bits and appears in every URL, referrer and
  // screenshot, while the token is 256. Leaving these ungated because "a
  // config isn't room state" is exactly the reasoning that produced a
  // room-hijack hole here once already.
  app.get('/api/rooms/:id/configs', (c) => {
    const guarded = requireRoom(c);
    if (guarded instanceof Response) return guarded;
    const scope = roomScope(guarded.room.id);
    return c.json({ configs: readConfigs(scope), crews: readCrews(scope) });
  });

  app.post('/api/rooms/:id/configs', async (c) => {
    const guarded = requireRoom(c);
    if (guarded instanceof Response) return guarded;
    const result = saveConfig(await c.req.json().catch(() => null), roomScope(guarded.room.id));
    // `problems` is written to be read by a human and is surfaced verbatim —
    // `agentConfig.ts` goes to real trouble to name the offending field,
    // because a rejection nobody can act on is a support ticket.
    return result.ok ? c.json({ config: result.config }) : c.json({ problems: result.problems }, 400);
  });

  app.post('/api/rooms/:id/crews', async (c) => {
    const guarded = requireRoom(c);
    if (guarded instanceof Response) return guarded;
    const body = (await c.req.json().catch(() => null)) as { graph?: unknown } | null;

    // ACYCLICITY IS CHECKED AT SAVE TIME, not at run time (phase 14). Refusing
    // at run time would mean a saved workflow that can never run, discovered by
    // a user who has already drawn it. Checked HERE rather than inside
    // `configStore.saveCrew`, because `hasCycle` lives in `workflowRunner.ts`,
    // which reaches `crews.ts`, which reaches `configStore.ts` — importing it
    // there would close a real cycle in the module graph while looking for one
    // in the data.
    const graph = body?.graph;
    // `hasCycle` walks `nodes`/`edges` directly, so it is only safe on a body
    // that has that shape. Anything else is left for `saveCrew` to refuse with
    // its own readable problems rather than throwing here into a bare 500.
    const g = graph as { nodes?: unknown; edges?: unknown } | null | undefined;
    const looksLikeGraph =
      typeof g === 'object' &&
      g !== null &&
      Array.isArray(g.nodes) &&
      Array.isArray(g.edges) &&
      g.nodes.every((n) => typeof n === 'object' && n !== null && typeof (n as { id?: unknown }).id === 'string') &&
      g.edges.every(
        (e) => typeof e === 'object' && e !== null && typeof (e as { from?: unknown }).from === 'string',
      );
    if (looksLikeGraph && hasCycle(graph as Parameters<typeof hasCycle>[0])) {
      return c.json({ problems: ['This workflow has a cycle, so it could never finish.'] }, 400);
    }

    const result = saveCrew(body, roomScope(guarded.room.id));
    return result.ok ? c.json({ crew: result.crew }) : c.json({ problems: result.problems }, 400);
  });

  app.delete('/api/rooms/:id/configs/:name', (c) => {
    const guarded = requireRoom(c);
    if (guarded instanceof Response) return guarded;
    return deleteConfig(c.req.param('name') ?? '', roomScope(guarded.room.id))
      ? c.json({ deleted: true })
      : c.json({ error: 'No such config.' }, 404);
  });

  app.delete('/api/rooms/:id/crews/:name', (c) => {
    const guarded = requireRoom(c);
    if (guarded instanceof Response) return guarded;
    return deleteCrew(c.req.param('name') ?? '', roomScope(guarded.room.id))
      ? c.json({ deleted: true })
      : c.json({ error: 'No such crew.' }, 404);
  });

  /**
   * Start a saved crew's graph as a real fleet run.
   *
   * A REST route rather than a new wire frame on purpose: a run's PROGRESS is
   * already observable through the transient `fleet` frame and the event log,
   * which is the whole claim of this phase — the canvas is a view over the
   * orchestration model, not a second one. A new frame would be a second
   * channel carrying facts that already have one.
   */
  app.post('/api/rooms/:id/crews/:name/run', async (c) => {
    const guarded = requireRoom(c);
    if (guarded instanceof Response) return guarded;
    const runtime = getRuntime(guarded.room.id);
    if (runtime === undefined) return c.json({ error: 'That room is not attached.' }, 409);

    const crew = readCrew(c.req.param('name') ?? '', roomScope(guarded.room.id));
    if (crew === null) return c.json({ error: 'No such crew.' }, 404);
    if (crew.graph === undefined) {
      return c.json({ error: 'That crew has no workflow graph. Launch it as a crew instead.' }, 400);
    }

    const body = (await c.req.json().catch(() => ({}))) as { prompt?: unknown };
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (prompt.trim() === '') return c.json({ error: 'A run needs a prompt.' }, 400);

    // DRIVER-ONLY, like spawn/stop over the socket. A REST call has no socket,
    // so the caller proves WHO they are with the same participant id + resume
    // secret the reconnect path trusts. The refusal text is surfaced verbatim
    // by the UI. With no driver at all the room is open-floor and anyone
    // holding the token may run, matching the WS rule.
    const room = guarded.room;
    const claimedId = c.req.header('X-SynCode-Participant') ?? '';
    const claimedSecret = c.req.header('X-SynCode-Resume') ?? '';
    const caller = claimedId !== '' && verifyParticipant(room, claimedId, claimedSecret) ? claimedId : null;
    if (room.driverId !== null && (caller === null || !isDriver(room, caller))) {
      return c.json({ error: 'Only the driver can run a workflow.' }, 403);
    }

    // Resolve every config first, like `launchCrew`: a node whose config was
    // deleted would otherwise error mid-run and silently skip its descendants.
    const scope = roomScope(room.id);
    const missing = [
      ...new Set(crew.graph.nodes.filter((n) => readConfig(n.configName, scope) === null).map((n) => n.configName)),
    ];
    if (missing.length > 0) {
      const one = missing.length === 1;
      return c.json(
        {
          error: `This workflow uses ${one ? 'a config' : 'configs'} that ${one ? 'is' : 'are'} not saved: ${missing
            .map((m) => `"${m}"`)
            .join(', ')}. Save ${one ? 'it' : 'them'} or pick another.`,
        },
        400,
      );
    }

    // Attributed to the verified caller (the driver), server-side (I2').
    const attributedId = caller ?? room.driverId;
    const by = {
      participantId: attributedId ?? 'unknown',
      displayName: (attributedId === null ? undefined : room.participants.get(attributedId)?.displayName) ?? 'Someone',
    };
    const result = startWorkflowRun({
      runtime,
      graph: crew.graph,
      prompt,
      by,
      rolePrompt: (n) => readConfig(n.configName, scope)?.prompt,
    });
    if (!result.ok) return c.json({ error: result.reason }, 400);
    runRegistry.start({
      key: runKey(room.id, crew.name),
      run: result.run,
      nodeIds: crew.graph.nodes.map((n) => n.id),
      onTick: () => runtime.broadcastFleet(),
      alive: () => getRuntime(room.id) === runtime,
    });
    runtime.broadcastFleet();
    return c.json({ nodes: [...result.run.nodeAgentIds.entries()] });
  });

  /** What the last run of this workflow is doing: which agent became which
   *  node, and each node's status. Fleet membership still comes from the log
   *  and liveness from the `fleet` frame; this only maps node -> agent. */
  app.get('/api/rooms/:id/crews/:name/run', (c) => {
    const guarded = requireRoom(c);
    if (guarded instanceof Response) return guarded;
    const snapshot = runRegistry.snapshot(runKey(guarded.room.id, c.req.param('name') ?? ''));
    return snapshot === undefined ? c.json({ error: 'No run for that workflow.' }, 404) : c.json(snapshot);
  });
  // --- END phase-13 config + crew routes ---

  app.get('/api/rooms/:id/workspace/tree', (c) => {
    const guarded = requireRoom(c);
    if (guarded instanceof Response) return guarded;
    try {
      return c.json({ entries: listTree(guarded.room, c.req.query('path') ?? '') });
    } catch (error) {
      return workspaceErrorResponse(c, error);
    }
  });

  app.get('/api/rooms/:id/workspace/file', (c) => {
    const guarded = requireRoom(c);
    if (guarded instanceof Response) return guarded;
    try {
      return c.json(readWorkspaceFile(guarded.room, c.req.query('path') ?? ''));
    } catch (error) {
      return workspaceErrorResponse(c, error);
    }
  });

  app.get('/api/rooms/:id/git/status', async (c) => {
    const guarded = requireRoom(c);
    if (guarded instanceof Response) return guarded;
    try {
      return c.json(await getGitStatus(guarded.room));
    } catch {
      return c.json({ error: 'Could not read git status for this room.' }, 500);
    }
  });

  app.get('/api/rooms/:id/git/diff', async (c) => {
    const guarded = requireRoom(c);
    if (guarded instanceof Response) return guarded;
    const path = c.req.query('path');
    if (path === undefined || path === '') {
      return c.json({ error: 'A path query parameter is required.' }, 400);
    }
    try {
      return c.json({ diff: await getGitDiff(guarded.room, path) });
    } catch {
      return c.json({ error: 'Could not read a diff for that path.' }, 500);
    }
  });

  app.get('/api/rooms/:id/models', async (c) => {
    const guarded = requireRoom(c);
    if (guarded instanceof Response) return guarded;
    const runtime = getRuntime(guarded.room.id);
    if (runtime === undefined) {
      return c.json({ error: 'This room has no running agent yet.' }, 503);
    }
    try {
      return c.json({ models: await runtime.agent.listModels() });
    } catch {
      return c.json({ error: 'Could not list available models.' }, 500);
    }
  });
  // --- END phase-7 workspace routes ---

  // --- BEGIN phase-3c re-entry slot: add POST /api/rooms/:id/key here, so a
  // room recovered without its key (I4) can be re-opened by its creator. ---
  app.post('/api/rooms/:id/key', async (c) => {
    const room = getRoom(c.req.param('id'));
    if (room === undefined) return c.json({ error: 'No such room.' }, 404);

    // The TOKEN is the credential, not the room id. The id is 64 bits and
    // appears in every room URL, referrer header and screenshot; the token is
    // 256 bits and is the thing "the link is the credential" actually means.
    // Without this check anyone who had merely seen a room id could attach
    // their own key, and because attachRoom is idempotent (I1) whoever wins
    // that race owns the room's one live agent permanently — a later re-key
    // by the real creator is accepted and then silently never used.
    const token = roomTokenHeader(c);
    if (token === undefined || authorize(room.id, token) === undefined) {
      return c.json({ error: 'Invalid room token.' }, 401);
    }

    const body = (await c.req.json().catch(() => null)) as { apiKey?: string } | null;
    const keyCheck = validateApiKeyShape(body?.apiKey);
    if (!keyCheck.ok) return c.json({ error: keyCheck.message }, 400);

    attachApiKey(room, keyCheck.apiKey);
    attachRoom(room); // idempotent — returns the existing runtime if any (I1)
    return c.json({ ok: true });
  });
  // --- END phase-3c re-entry slot ---

  // The Docker image copies the Vite bundle to apps/web/dist, but no Phase 1
  // plan owned the wiring between the two: phase-1b owns client/**, phase-1c
  // owns the Dockerfile, and this seam belongs to neither. Registered after
  // the API routes so /healthz and /api/* always win.
  //
  // phase-5a: an explicit allow-list, still NOT a catch-all. Client-side
  // routing (client/src/router.tsx) needs each page path to return the SPA
  // shell so the browser's own address bar can land directly on /new,
  // /privacy, /terms or /security, but a wildcard would swallow unmatched
  // API typos into a 200 and make them very hard to debug — that is the
  // entire reason this list is enumerated rather than a fallthrough.
  // Adding a page means adding its path here; that friction is intentional.
  // A room link is "/?room=…&token=…" (and now also "/room?…"), so "/"
  // serves the shell either way and the client decides which view to mount.
  /**
   * The page paths, from `@syncode/protocol/pages` rather than written out here.
   *
   * This line used to be its own hand-kept array while the web app's router
   * kept a second one. `/download` was added to the client and to neither of
   * the other two places: it resolved, rendered the landing page, and — once
   * that was fixed — still 404'd on the deployed site while working perfectly
   * in development, because vite's dev server is a catch-all and this
   * deliberately is not.
   *
   * Still NOT a catch-all: an unmatched `/api/*` must keep 404ing rather than
   * returning index.html with a 200, which is what sends a client off to parse
   * `<!doctype html>` as JSON.
   */
  const PAGE_ROUTES = PAGE_PATHS;
  // Anchored to this module, NOT to process.cwd(). Before the monorepo move
  // the default was the cwd-relative 'apps/web/dist', which worked only because
  // every invocation path happened to run from the repo root. Under workspaces
  // `npm run dev -w @syncode/server` runs with cwd=apps/server, and that
  // coincidence is gone.
  //
  // `../../../web/dist` resolves identically from source and from build output
  // because src/server/ and dist/server/ sit at the same depth under
  // apps/server/. serveStatic joins this with path.join and stats the result,
  // so an absolute path is fine — only *relative* ones are cwd-sensitive.
  const clientDir =
    readEnv('CLIENT_DIR') ?? fileURLToPath(new URL('../../../web/dist', import.meta.url));
  /**
   * CACHE HEADERS, and the two rules are deliberately opposite.
   *
   * Neither route set one before, so the SPA shell was served with only
   * `Last-Modified` — which lets a browser cache it heuristically and skip
   * revalidating. A returning visitor was then handed a STALE `index.html`,
   * which names a content-hashed bundle, and after a deploy that hash is gone:
   * `/assets/index-<old>.js` returns 404. They see the previous page or a
   * broken one, redeploying does not help them, and from the outside it looks
   * exactly like the deploy never happened. It was reported that way.
   *
   * The shell's URL never changes while its content does on every deploy, so it
   * must be revalidated every time — `no-cache` means "ask first", not "do not
   * store", so a 304 still saves the bytes.
   *
   * A hashed asset is the mirror image: its URL changes whenever its content
   * does, so the bytes behind one can never differ and it is safe forever.
   * `immutable` additionally tells the browser not to revalidate even on a
   * reload.
   *
   * Verified against a running server, not just the suite — and the first
   * attempt to do so lied. `curl` reported no headers at all, which looked like
   * the middleware failing; the real cause was an OLD server still holding
   * :8099 while the new one had died on EADDRINUSE, so every request was being
   * answered by the previous build. CLAUDE.md warns about exactly that port on
   * this machine. Kill by PID and re-check before believing a negative result.
   */
  app.use('/assets/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  app.use('/assets/*', serveStatic({ root: clientDir }));
  for (const path of PAGE_ROUTES) {
    app.get(path, async (c, next) => {
      await next();
      c.header('Cache-Control', 'no-cache');
    });
  }
  for (const path of PAGE_ROUTES) {
    app.get(path, serveStatic({ path: `${clientDir}/index.html` }));
  }
  for (const path of PAGE_ROUTES) {
    app.get(path, (c) =>
      c.text(
        'SynCode server is running, but no client bundle was found. ' +
          'Run `npm run build:client`, or set NEXUS_CLIENT_DIR.',
        503,
      ),
    );
  }

  // --- BEGIN phase-19b terminals ---
  const ptyFactory = opts.terminals;
  const terminalRooms = new Map<string, TerminalRoom>();
  /**
   * Sockets whose TCP peer is loopback: the person at the desktop app hosting
   * this room. Only they may switch terminals on or off. Read from the raw
   * socket at upgrade, never from anything a client sends — the same source
   * `localHost.ts`'s second lock uses.
   */
  const hostSockets = new WeakSet<WebSocket>();

  // --- BEGIN phase-20 share links ---
  /** Per room, the links the desktop says reach it from other machines. */
  const shareLinks = new Map<string, ShareLinks>();
  function sendShareLinks(room: Room, only?: WebSocket): void {
    const links = shareLinks.get(room.id) ?? { web: null, lan: [] };
    const targets = only === undefined ? [...room.sockets] : [only];
    for (const target of targets) {
      const socket = target as WebSocket;
      // Host sockets only: the links carry the token, and a guest already
      // holds a link that works for them.
      if (!hostSockets.has(socket)) continue;
      socket.send(JSON.stringify({ kind: 'share_links', web: links.web, lan: links.lan }));
    }
  }
  function setShareLinks(roomId: string, links: ShareLinks): void {
    shareLinks.set(roomId, { web: links.web, lan: [...links.lan] });
    const room = getRoom(roomId);
    if (room !== undefined) sendShareLinks(room);
  }
  // --- END phase-20 share links ---

  function sendTerminals(room: Room, terminals: TerminalRoom, only?: WebSocket): void {
    const list = terminals.list();
    const targets = only === undefined ? [...room.sockets] : [only];
    for (const target of targets) {
      const socket = target as WebSocket;
      socket.send(
        JSON.stringify({
          kind: 'terminals',
          enabled: terminals.enabled,
          canManage: hostSockets.has(socket),
          list,
        }),
      );
    }
  }

  function terminalsFor(room: Room): TerminalRoom | undefined {
    if (ptyFactory === undefined) return undefined;
    const existing = terminalRooms.get(room.id);
    if (existing !== undefined) return existing;
    const runtime = getRuntime(room.id);
    if (runtime === undefined) return undefined;
    const created: TerminalRoom = createTerminalRoom({
      cwd: room.cwd,
      factory: ptyFactory,
      commit: (event) => void runtime.commit(event),
      send: (socket, frame) => (socket as WebSocket).send(JSON.stringify(frame)),
      onListChanged: () => sendTerminals(room, created),
    });
    terminalRooms.set(room.id, created);
    return created;
  }
  // --- END phase-19b terminals ---

  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    // --- BEGIN phase-20 relay (WebSocket) ---
    if (relay !== undefined && url.pathname === RELAY_HOST_PATH) {
      relay.handleHostUpgrade(request, socket, head, upgradeClientIp(request));
      return;
    }
    if (
      relay !== undefined &&
      url.pathname === '/ws' &&
      relay.handleGuestUpgrade(
        request,
        socket,
        head,
        url.searchParams.get('room') ?? '',
        url.searchParams.get('token') ?? '',
      )
    ) {
      return;
    }
    // --- END phase-20 relay (WebSocket) ---
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const roomId = url.searchParams.get('room') ?? '';
      const token = url.searchParams.get('token') ?? '';
      const displayName = (url.searchParams.get('name') ?? 'anonymous').slice(0, 40);

      const room = authorize(roomId, token);
      if (room === undefined) {
        ws.close(4401, 'unauthorized');
        return;
      }
      // A room recovered after a restart (plan phase-3a) has its history but
      // no API key — I4 forbids persisting one. Refuse plainly rather than
      // attaching an agent that would throw on its first prompt.
      if (!hasApiKey(room)) {
        ws.close(4409, 'needs_api_key');
        return;
      }
      const runtime = getRuntime(room.id) ?? attachRoom(room);
      // A returning socket may reclaim its identity by presenting both the id
      // and the resume token it was issued. Anything else mints a fresh one.
      const identity = resolveParticipantId(
        room,
        url.searchParams.get('participant'),
        url.searchParams.get('resume'),
        displayName,
      );
      const participantId = identity.participantId;
      if ((opts.hostPeer ?? isLoopbackAddress)(request.socket.remoteAddress)) hostSockets.add(ws);

      const parsedSince = Number.parseInt(url.searchParams.get('since') ?? '0', 10);
      const from = Number.isFinite(parsedSince) && parsedSince > 0 ? parsedSince : 0;

      // Replay first, then attach. Order matters: attaching before replay
      // finishes interleaves history with live events. Never renumber or
      // backfill to make this simpler — the log is append-only and
      // authoritative (I3); `since` only filters what gets resent.
      for (const event of runtime.sink.read()) {
        if (event.seq <= from) continue;
        ws.send(JSON.stringify({ kind: 'event', event }));
      }
      ws.send(
        JSON.stringify({
          kind: 'replay_complete',
          lastSeq: room.peekSeq(),
          protocolVersion: PROTOCOL_VERSION,
          // Tell this socket who it is, and how to prove it next time. Only
          // this socket receives it — never broadcast, never logged.
          participantId,
          resumeToken: identity.resumeToken,
          terminals: ptyFactory !== undefined,
        }),
      );

      runtime.addSocket(ws, participantId);
      cancelAutoRelease(room, participantId);
      room.participants.set(participantId, { id: participantId, displayName, connected: true });
      runtime.commit({ type: 'participant_joined', participantId, displayName });
      runtime.broadcast(presenceFrame(room));
      /**
       * And the FLEET, to this socket alone.
       *
       * `broadcastFleet()` fires when the fleet changes — spawn, stop, model
       * switch, crew run. A socket that connects after the last of those
       * receives events, `replay_complete` and `presence`, and then nothing
       * about the fleet at all, so its fleet view stays empty and its agent
       * count stays at one until somebody happens to change something.
       *
       * The frame cannot be recovered from the replay this socket just got:
       * it is deliberately transient and unlogged ("liveness, never
       * membership" — see `broadcastFleet`'s comment in ws.ts), and transient
       * state has to be handed to a joiner explicitly. Presence, right above,
       * has always done exactly this; the fleet simply never did.
       *
       * Found by opening a room holding eight live agents in a browser and
       * reading "1 agent" in the status bar. Every suite was green, because
       * every test that asserts on a fleet frame first does something that
       * triggers one.
       *
       * Sent to THIS socket rather than broadcast: a person joining does not
       * change anyone else's fleet, and re-broadcasting to the whole room on
       * every join is noise that grows with the number of people watching.
       */
      ws.send(JSON.stringify({ kind: 'fleet', agents: fleetSnapshot(runtime) }));
      // Phase 19b: like the fleet, the terminal list is transient and must be
      // handed to a joiner explicitly.
      const joinTerminals = terminalsFor(room);
      if (joinTerminals !== undefined) sendTerminals(room, joinTerminals, ws);
      // Phase 21: edits being typed right now, as they stand.
      for (const preview of runtime.livePreviews()) ws.send(JSON.stringify({ kind: 'edit_preview', preview }));
      // Phase 20: the host's window needs the shareable links (it is loaded
      // from 127.0.0.1); `sendShareLinks` skips non-host sockets.
      if (shareLinks.has(room.id)) sendShareLinks(room, ws);

      ws.on('message', (data) => {
        const frame = parseClientFrame(String(data));
        if (frame === null) {
          ws.send(JSON.stringify({ kind: 'error', message: 'Unrecognized message.' }));
          return;
        }
        if (frame.kind === 'prompt') {
          // VALIDATE BEFORE ANY SIDE EFFECT. An unknown agent is refused rather
          // than steered to the primary one — a stale or typo'd id must not
          // quietly drive a different agent — and that check has to happen
          // BEFORE claimIfVacant, not after.
          //
          // It used to happen after, which meant a prompt naming a nonexistent
          // agent was rejected *and still granted its sender the driver token*,
          // appending a `driver_granted` the append-only log can never take back
          // (I3). Any participant could seize the floor with a deliberately
          // malformed prompt they knew would be refused.
          const target = runtime.getAgent(frame.agentId);
          if (target === undefined) {
            ws.send(
              JSON.stringify({ kind: 'error', message: 'That agent is not in this room.' }),
            );
            return;
          }
          // First speaker in an idle room claims the token.
          for (const event of claimIfVacant(room, participantId, displayName)) {
            runtime.commit(event);
          }
          // I2': the floor is open. The token no longer decides who may speak —
          // it decides whose instruction wins when two conflict, and that is
          // arbitrated by the agent, not here. What is still enforced at the
          // server is attribution: wasDriver is derived from room.driverId and
          // never read off the client frame, so it cannot be forged.
          const wasDriver = isDriver(room, participantId);
          const logged = runtime.commit({
            type: 'user_prompt',
            participantId,
            displayName,
            text: frame.text,
            wasDriver,
          });
          target.submit({
            seq: logged.seq,
            displayName,
            text: frame.text,
            wasDriver,
          });
          return;
        }

        if (frame.kind === 'request_control') {
          for (const event of requestControl(room, participantId, displayName)) {
            runtime.commit(event);
          }
          return;
        }

        if (frame.kind === 'grant_control') {
          const events = grantControl(room, participantId, frame.toParticipantId);
          if (events.length === 0) {
            ws.send(
              JSON.stringify({ kind: 'error', message: 'Only the driver can hand over control.' }),
            );
            return;
          }
          for (const event of events) runtime.commit(event);
          return;
        }

        if (frame.kind === 'release_control') {
          for (const event of releaseControl(room, participantId, 'explicit')) {
            runtime.commit(event);
          }
          return;
        }
        if (frame.kind === 'permission_decision') {
          // Any participant may decide — not only the driver.
          //
          // Routed through the runtime rather than reaching into one gate:
          // request ids are minted per gate, so once a room can hold more than
          // one agent a bare id is ambiguous, and settling the wrong agent's
          // tool call with this vote would be an unauthorised approval.
          const outcome = runtime.resolvePermission(frame.requestId, {
            decision: frame.decision,
            participantId,
            displayName,
            via: 'first_response',
            reason: frame.reason ?? null,
          }, frame.agentId);
          // Three causes, three messages. Collapsing them into "already decided"
          // was actively harmful for `unknown-agent`: that request is STILL OPEN
          // and still counting down to a timeout-deny, so telling the person it
          // was already settled makes them stop watching an approval that then
          // auto-denies — the opposite of what the gate exists to guarantee.
          if (outcome === 'unknown-agent') {
            ws.send(JSON.stringify({ kind: 'error', message: 'That agent is not in this room.' }));
          } else if (outcome === 'not-found') {
            ws.send(JSON.stringify({ kind: 'error', message: 'That approval was already decided.' }));
          }
          return;
        }

        // --- BEGIN phase-19a auto mode ---
        if (frame.kind === 'set_auto_mode') {
          // Any participant, driver or not — the user's decision, and the same
          // reasoning as permission_decision above: approving is not steering.
          // Setting the value it already has commits nothing, so a double
          // click or two people flipping it at once cannot spam the log.
          const isOn = room.autoMode !== null;
          if (frame.enabled === isOn) return;
          room.autoMode = frame.enabled ? { participantId, displayName } : null;
          runtime.commit({
            type: 'auto_mode_changed',
            enabled: frame.enabled,
            participantId,
            displayName,
            reason: 'participant',
          });
          // Committed BEFORE settling, so the log reads "auto mode went on,
          // then these were approved by it" — cause before effect (I3).
          if (frame.enabled) {
            runtime.settleAllPending({
              decision: 'allow',
              participantId,
              displayName,
              via: 'auto_mode',
              reason: null,
            });
          }
          return;
        }
        // --- END phase-19a auto mode ---

        // --- BEGIN phase-19b terminal frames ---
        if (
          frame.kind === 'term_open' ||
          frame.kind === 'term_attach' ||
          frame.kind === 'term_input' ||
          frame.kind === 'term_resize' ||
          frame.kind === 'term_close' ||
          frame.kind === 'set_terminal_access'
        ) {
          const terminals = terminalsFor(room);
          const fail = (message: string): void => ws.send(JSON.stringify({ kind: 'error', message }));
          if (terminals === undefined) {
            fail('Terminals are only available in rooms hosted from the SynCode desktop app.');
            return;
          }
          const peer = { participantId, displayName };
          switch (frame.kind) {
            case 'term_open': {
              const result = terminals.open(peer, frame.cols, frame.rows);
              if (!result.ok) fail(result.reason);
              else terminals.attach(ws, result.termId); // the opener watches what they opened
              return;
            }
            case 'term_attach':
              if (!terminals.attach(ws, frame.termId)) fail('That terminal is not open.');
              return;
            case 'term_input':
              if (!terminals.input(peer, frame.termId, frame.data)) fail('That terminal is not open.');
              return;
            case 'term_resize':
              terminals.resize(frame.termId, frame.cols, frame.rows);
              return;
            case 'term_close':
              if (!terminals.close(peer, frame.termId)) fail('That terminal is not open.');
              return;
            case 'set_terminal_access':
              if (!hostSockets.has(ws)) {
                fail('Only the host can switch terminals on or off.');
                return;
              }
              terminals.setEnabled(peer, frame.enabled);
              return;
          }
        }
        // --- END phase-19b terminal frames ---

        // --- BEGIN phase-7 set_model branch ---
        // phase-7a owns this region. The `set_model` frame branch goes HERE, in
        // index.ts — NOT in ws.ts, which has no message handling at all. Reject
        // a non-driver with an error frame when room.driverId !== null (reuse
        // isDriver, already imported above); open when the floor is open,
        // matching request_control's existing semantics. Then fire-and-forget
        // the promise the way the interrupt branch below already does — do NOT
        // make this handler async, or one model switch serializes every
        // subsequent message from that socket.
        if (frame.kind === 'set_model') {
          if (room.driverId !== null && !isDriver(room, participantId)) {
            ws.send(
              JSON.stringify({ kind: 'error', message: 'Only the driver can switch the model.' }),
            );
            return;
          }
          // Routed per agent (phase 12). Absent `agentId` means the primary
          // agent, which is what every pre-fleet client sends — so a v1 client
          // is byte-identical. An id naming no live agent is refused rather
          // than silently falling back: switching the wrong agent's model is a
          // steering failure, and `getAgent` deliberately does not default.
          const modelTarget = runtime.getAgent(frame.agentId);
          if (modelTarget === undefined) {
            ws.send(JSON.stringify({ kind: 'error', message: 'That agent is not in this room.' }));
            return;
          }
          void modelTarget
            .setModel(frame.model)
            .then(() => {
              runtime.commitAs(frame.agentId ?? PRIMARY_AGENT_ID, {
                type: 'model_changed',
                participantId,
                displayName,
                model: frame.model,
              });
              runtime.broadcastFleet();
            })
            .catch(() => {
              // Never interpolate the raw error: it can carry the API key, and
              // this text is committed to the durable log (I4).
              runtime.commit({
                type: 'agent_error',
                message: 'Could not switch the model — the session may have already ended.',
              });
            });
          return;
        }
        // --- END phase-7 set_model branch ---

        // --- BEGIN phase-3b interrupt slot: add the `interrupt` frame branch here. ---
        if (frame.kind === 'interrupt') {
          // Deliberately NOT gated on the driver token — this is the safety
          // valve. A runaway agent must not require finding the token holder.
          runtime.commit({ type: 'interrupted', participantId, displayName });
          // phase-4 widened this signature: a discarded batch is logged with
          // the identity of whoever stopped it.
          // Fans out to EVERY attached agent. The `interrupted` event this
          // commits is room-wide, so interrupting only the primary agent would
          // make the log claim everything stopped while another agent kept
          // running with its batch undiscarded. Of all the operations still
          // addressed per-room, Stop is the one that must not be partial — it
          // is the safety valve.
          // Phase 12: an explicit `agentId` stops exactly that agent; an ABSENT
          // one still fans out to every agent, unchanged. That asymmetry is
          // deliberate. Stop is the safety valve, and the `interrupted` event
          // committed just above is room-wide — so the default must keep
          // meaning "stop everything", or the log would claim the room stopped
          // while agents kept running. Naming an agent is an opt-in narrowing,
          // never the default.
          const stopTargets =
            frame.agentId === undefined
              ? [...runtime.agents.values()]
              : [runtime.getAgent(frame.agentId)].filter(
                  (handle): handle is NonNullable<typeof handle> => handle !== undefined,
                );
          void Promise.all(
            stopTargets.map((handle) => handle.interrupt({ participantId, displayName })),
          ).catch(() => {
            // Never interpolate the raw error: it can carry the API key, and
            // this text is committed to the durable log (I4). The SDK rejecting
            // here almost always just means the session already ended.
            runtime.commit({
              type: 'agent_error',
              message: 'Could not stop the agent — the session may have already ended.',
            });
          });
          return;
        }
        // --- END phase-3b interrupt slot ---

        // --- BEGIN phase-12 fleet frames ---
        // Gated on the driver token with EXACTLY `set_model`'s semantics —
        // refused when someone holds it, open when the floor is open. Adding
        // or killing an agent reshapes the room more than switching a model
        // does, so it cannot be looser than the thing it is stricter than.
        if (frame.kind === 'spawn_agent' || frame.kind === 'stop_agent') {
          if (room.driverId !== null && !isDriver(room, participantId)) {
            ws.send(
              JSON.stringify({ kind: 'error', message: 'Only the driver can change the fleet.' }),
            );
            return;
          }
          const by = { participantId, displayName };
          const result =
            frame.kind === 'spawn_agent'
              ? spawnAgent({
                  runtime,
                  displayName: frame.displayName,
                  provider: frame.provider,
                  model: frame.model,
                  by,
                  ...(frame.configName === undefined ? {} : { configName: frame.configName }),
                })
              : stopAgent({ runtime, agentId: frame.agentId, by });
          if (!result.ok) {
            // `reason` is written to be shown — a refusal a human cannot act on
            // is a support ticket, and "the fleet is full" is exactly the thing
            // a person needs to be told rather than left guessing at.
            ws.send(JSON.stringify({ kind: 'error', message: result.reason }));
            return;
          }
          runtime.broadcastFleet();
          return;
        }
        // --- END phase-12 fleet frames ---
        // --- BEGIN phase-13 launch_crew frame ---
        // Same driver semantics as spawn/stop above: a crew IS a spawn, several
        // at once, and is exactly how a person will first meet the fleet's
        // resource cap.
        if (frame.kind === 'launch_crew') {
          if (room.driverId !== null && !isDriver(room, participantId)) {
            ws.send(
              JSON.stringify({ kind: 'error', message: 'Only the driver can launch a crew.' }),
            );
            return;
          }
          const result = launchCrew({
            runtime,
            crewName: frame.crewName,
            by: { participantId, displayName },
            // Same room-scoped store the REST routes use — a crew launched
            // over the socket must resolve to the same configs a person just
            // saved over HTTP, and must not reach another room's.
            dataDir: join(DATA_DIR_ROOT, 'roomdata', room.id),
          });
          if (!result.ok) {
            ws.send(JSON.stringify({ kind: 'error', message: result.reason }));
            return;
          }
          runtime.broadcastFleet();
          return;
        }
        // --- END phase-13 launch_crew frame ---


        // --- BEGIN phase-11 collaborative document frames ---
        // Deliberately NOT gated on the driver token, for every one of the
        // four frames below — see wire.ts's own comment on `doc_sync`: the
        // token arbitrates who steers the AGENT (I2'), and a multiplayer
        // editor where only one person may type is a screen share. Any
        // participant may open, edit, watch or close any file.
        if (frame.kind === 'doc_open') {
          runtime.docOpen(ws, participantId, frame.path).catch((error: unknown) => {
            // WorkspacePathError's messages are already written to be shown
            // (the same "never surface the raw error" discipline used
            // elsewhere in this file) — anything else is unexpected and gets
            // a generic message instead of a raw stack trace over the wire.
            ws.send(
              JSON.stringify({
                kind: 'error',
                message: error instanceof WorkspacePathError ? error.message : 'Could not open that file.',
              }),
            );
          });
          return;
        }

        if (frame.kind === 'doc_close') {
          runtime.docClose(ws, participantId, frame.path);
          return;
        }

        if (frame.kind === 'doc_sync') {
          void runtime.docApplySync(ws, participantId, frame.path, frame.payload).catch(() => {
            // A malformed or corrupt payload (bad base64, truncated JSON, a
            // change bundle Automerge rejects) — never surface the raw
            // decode error, and never let it take the socket down.
            ws.send(JSON.stringify({ kind: 'error', message: 'Could not apply that edit.' }));
          });
          return;
        }

        if (frame.kind === 'doc_presence') {
          runtime.docSetPresence(ws, participantId, displayName, frame.path, frame.anchor, frame.head);
          return;
        }
        // --- END phase-11 collaborative document frames ---
      });

      ws.on('close', () => {
        // Every path THIS socket opened, regardless of whether other sockets
        // (this participant's other tabs, or other people) still have it —
        // see `docDisconnect`'s own comment for the one-tab-per-file
        // simplification this accepts.
        runtime.docDisconnect(ws, participantId);
        terminalRooms.get(room.id)?.detachSocket(ws);
        runtime.removeSocket(ws);
        // Two tabs can share one identity now that ids survive a reconnect.
        // Closing one of them is not the person leaving, and must not arm the
        // driver grace timer while they are still here in the other tab.
        if (runtime.participantSocketCount(participantId) > 0) return;
        const participant = room.participants.get(participantId);
        if (participant !== undefined) participant.connected = false;
        runtime.commit({ type: 'participant_left', participantId, displayName });
        // phase-2b: the roster must show them greyed out immediately.
        runtime.broadcast(presenceFrame(room));
        // phase-2a: their token is held for a grace period rather than dropped
        // now, so a refresh does not cost them control. The later
        // driver_released event is what updates every client, so no second
        // presence frame is needed here.
        if (isDriver(room, participantId)) {
          scheduleAutoRelease(room, participantId, (events) => {
            for (const event of events) runtime.commit(event);
          });
        }
      });
    });
  });

  // Deliberately generic rather than naming the two GitHub variables. Importing
  // github.ts deletes THOSE; the underlying fragility — agent.ts handing the
  // whole environment to a subprocess participants can drive — remains for
  // whatever secret someone adds next. This is the cheap guard for that.
  const leaked = findLeakedEnvSecrets();
  if (leaked.length > 0) {
    console.log(
      `WARNING: secret-shaped environment variables are visible to every room's agent: ${leaked.join(', ')}. ` +
        'Read them into module state and delete them from process.env, the way src/server/github.ts does.',
    );
  }

  for (const recovered of recoverRooms()) {
    console.log(
      `recovered room ${recovered.roomId} at seq ${recovered.lastSeq} (awaiting API key)`,
    );
  }

  return { app, server, setShareLinks, relay };
}

/** Same trust as `clientIp`, for an upgrade request (no Hono context there). */
function upgradeClientIp(request: IncomingMessage): string {
  const fly = request.headers['fly-client-ip'];
  if (typeof fly === 'string' && fly !== '') return fly;
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded !== '') return forwarded.split(',')[0]?.trim() ?? '';
  return request.socket.remoteAddress ?? 'unknown';
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('index.ts') || entry.endsWith('index.js')) {
  // Phase 20: the hosted server is the relay desktop hosts share through. A
  // desktop-shaped run (SYNCODE_LOCAL_HOST) never relays; SYNCODE_RELAY=0 turns
  // it off explicitly.
  const { server } = createServer({ relay: !isLocalHostMode() && readEnv('RELAY') !== '0' });
  const port = Number(process.env['PORT'] ?? 8080);
  server.listen(port, '0.0.0.0', () => {
    console.log(`syncode listening on :${port}`);
  });
}
