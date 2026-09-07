import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createAdaptorServer } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { WebSocketServer } from 'ws';
import type { GithubRepoRef } from '@nexus/protocol/events';
import { PRIMARY_AGENT_ID, PROTOCOL_VERSION } from '@nexus/protocol/events';
import { parseClientFrame } from '@nexus/protocol/wire';
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
import { attachRoom, getRuntime, resolveParticipantId } from './ws.js';
import { spawnAgent, stopAgent } from './fleet.js';
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
import { WorkspacePathError, listTree, readWorkspaceFile } from './workspace.js';

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
  return Number(process.env['NEXUS_ROOM_RATE_LIMIT'] ?? 5);
}
function createRoomRateWindowMs(): number {
  return Number(process.env['NEXUS_ROOM_RATE_WINDOW_MS'] ?? 10 * 60 * 1000);
}
function maxRooms(): number {
  return Number(process.env['NEXUS_MAX_ROOMS'] ?? 200);
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
  const configured = process.env['NEXUS_PUBLIC_URL'];
  if (configured !== undefined && configured !== '') return configured.replace(/\/+$/, '');
  const proto = c.req.header('X-Forwarded-Proto') ?? 'http';
  return `${proto}://${c.req.header('Host') ?? 'localhost'}`;
}

function githubCallbackUrl(c: Context): string {
  return `${publicOrigin(c)}/api/github/callback`;
}

export function createServer(
  opts: { agentDeps?: AgentDeps } = {},
): { app: Hono; server: Server } {
  const app = new Hono();

  // A room link is "/?room=…&token=…", and the token IS the credential. Without
  // this, following any outbound link from a room page — including the GitHub
  // authorize redirect this phase adds — hands the room token to the
  // destination in the Referer header. Registered before every route so no
  // handler can be reached without it.
  app.use('*', async (c, next) => {
    await next();
    c.header('Referrer-Policy', 'no-referrer');
  });

  app.get('/healthz', (c) =>
    c.json({ ok: true, githubConnectEnabled: hasGithubAppConfig() }),
  );

  // --- BEGIN phase-6 GitHub App connect routes ---

  app.get('/api/github/status', (c) => c.json({ enabled: hasGithubAppConfig() }));

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
        return c.json({ error: 'Nexus is at capacity. Try again later.' }, 503);
      }

      const body = (await c.req.json().catch(() => null)) as
        | {
            apiKey?: string;
            repoUrl?: string | null;
            connectId?: string;
            owner?: string;
            repo?: string;
          }
        | null;

      const keyCheck = validateApiKeyShape(body?.apiKey);
      if (!keyCheck.ok) return c.json({ error: keyCheck.message }, 400);

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
    const token = c.req.header('X-Nexus-Token');
    if (token === undefined || authorize(room.id, token) === undefined) {
      return c.json({ error: 'Invalid room token.' }, 401);
    }
    return c.json(room.toJSON());
  });

  // --- BEGIN phase-7 workspace routes ---
  // phase-7a owns this region. Five GET routes go here:
  //   /api/rooms/:id/workspace/tree?path=   /api/rooms/:id/workspace/file?path=
  //   /api/rooms/:id/git/status             /api/rooms/:id/git/diff?path=
  //   /api/rooms/:id/models
  // Guard each exactly as GET /api/rooms/:id does above — X-Nexus-Token header
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
    const token = c.req.header('X-Nexus-Token');
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
    const token = c.req.header('X-Nexus-Token');
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
  const PAGE_ROUTES = ['/', '/new', '/privacy', '/terms', '/security', '/room'] as const;
  // Anchored to this module, NOT to process.cwd(). Before the monorepo move
  // the default was the cwd-relative 'apps/web/dist', which worked only because
  // every invocation path happened to run from the repo root. Under workspaces
  // `npm run dev -w @nexus/server` runs with cwd=apps/server, and that
  // coincidence is gone.
  //
  // `../../../web/dist` resolves identically from source and from build output
  // because src/server/ and dist/server/ sit at the same depth under
  // apps/server/. serveStatic joins this with path.join and stats the result,
  // so an absolute path is fine — only *relative* ones are cwd-sensitive.
  const clientDir =
    process.env['NEXUS_CLIENT_DIR'] ?? fileURLToPath(new URL('../../../web/dist', import.meta.url));
  app.use('/assets/*', serveStatic({ root: clientDir }));
  for (const path of PAGE_ROUTES) {
    app.get(path, serveStatic({ path: `${clientDir}/index.html` }));
  }
  for (const path of PAGE_ROUTES) {
    app.get(path, (c) =>
      c.text(
        'Nexus server is running, but no client bundle was found. ' +
          'Run `npm run build:client`, or set NEXUS_CLIENT_DIR.',
        503,
      ),
    );
  }

  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
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
        }),
      );

      runtime.addSocket(ws, participantId);
      cancelAutoRelease(room, participantId);
      room.participants.set(participantId, { id: participantId, displayName, connected: true });
      runtime.commit({ type: 'participant_joined', participantId, displayName });
      runtime.broadcast(presenceFrame(room));

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

  return { app, server };
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('index.ts') || entry.endsWith('index.js')) {
  const { server } = createServer();
  const port = Number(process.env['PORT'] ?? 8080);
  server.listen(port, '0.0.0.0', () => {
    console.log(`nexus listening on :${port}`);
  });
}
