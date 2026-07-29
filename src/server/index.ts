import type { Server } from 'node:http';
import { createAdaptorServer } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '../protocol/events.js';
import { parseClientFrame } from '../protocol/wire.js';
import { presenceFrame } from './presence.js';
import { recoverRooms, writeRoomMeta } from './recovery.js';
import { prepareWorkspace, validateApiKeyShape, validateRepoUrl } from './create.js';
import { attachApiKey, authorize, createRoom, getRoom, hasApiKey, mintRoomId } from './rooms.js';
import { attachRoom, getRuntime, resolveParticipantId } from './ws.js';
import {
  cancelAutoRelease,
  claimIfVacant,
  grantControl,
  isDriver,
  releaseControl,
  requestControl,
  scheduleAutoRelease,
} from './driver.js';

export function createServer(): { app: Hono; server: Server } {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.post('/api/rooms', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { apiKey?: string; repoUrl?: string | null }
      | null;

    const keyCheck = validateApiKeyShape(body?.apiKey);
    if (!keyCheck.ok) return c.json({ error: keyCheck.message }, 400);

    const repoCheck = validateRepoUrl(body?.repoUrl);
    if (!repoCheck.ok) return c.json({ error: repoCheck.message }, 400);

    // Name the workspace before the room exists, because cwd is readonly and
    // the agent reads it the moment the room attaches.
    const roomId = mintRoomId();
    let cwd: string;
    try {
      cwd = await prepareWorkspace(roomId, repoCheck.url);
    } catch {
      // Never surface the raw git error — it can echo the URL and credentials.
      return c.json(
        { error: 'Could not clone that repository. Check the URL and try again.' },
        400,
      );
    }

    const room = createRoom({ id: roomId, apiKey: keyCheck.apiKey, cwd, repoUrl: repoCheck.url });
    writeRoomMeta({
      roomId: room.id,
      token: room.token,
      cwd: room.cwd,
      repoUrl: room.repoUrl,
      createdAt: room.createdAt,
    });
    attachRoom(room);
    return c.json({ roomId: room.id, token: room.token });
  });

  app.get('/api/rooms/:id', (c) => {
    const room = getRoom(c.req.param('id'));
    if (room === undefined) return c.json({ error: 'No such room.' }, 404);
    const token = c.req.header('X-Nexus-Token');
    if (token === undefined || authorize(room.id, token) === undefined) {
      return c.json({ error: 'Invalid room token.' }, 401);
    }
    return c.json(room.toJSON());
  });

  // --- BEGIN phase-3c re-entry slot: add POST /api/rooms/:id/key here, so a
  // room recovered without its key (I4) can be re-opened by its creator. ---
  app.post('/api/rooms/:id/key', async (c) => {
    const room = getRoom(c.req.param('id'));
    if (room === undefined) return c.json({ error: 'No such room.' }, 404);

    const body = (await c.req.json().catch(() => null)) as { apiKey?: string } | null;
    const keyCheck = validateApiKeyShape(body?.apiKey);
    if (!keyCheck.ok) return c.json({ error: keyCheck.message }, 400);

    attachApiKey(room, keyCheck.apiKey);
    attachRoom(room); // idempotent — returns the existing runtime if any (I1)
    return c.json({ ok: true });
  });
  // --- END phase-3c re-entry slot ---

  // The Docker image copies the Vite bundle to client/dist, but no Phase 1
  // plan owned the wiring between the two: phase-1b owns client/**, phase-1c
  // owns the Dockerfile, and this seam belongs to neither. Registered after
  // the API routes so /healthz and /api/* always win. A room link is
  // "/?room=…&token=…", so only "/" and the hashed asset paths are needed —
  // no catch-all, which would otherwise swallow unmatched API typos into a
  // 200 and make them very hard to debug.
  const clientDir = process.env['NEXUS_CLIENT_DIR'] ?? 'client/dist';
  app.use('/assets/*', serveStatic({ root: clientDir }));
  app.get('/', serveStatic({ path: `${clientDir}/index.html` }));
  app.get('/', (c) =>
    c.text(
      'Nexus server is running, but no client bundle was found. ' +
        'Run `npm --prefix client run build`, or set NEXUS_CLIENT_DIR.',
      503,
    ),
  );

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
          // First speaker in an idle room claims the token.
          for (const event of claimIfVacant(room, participantId, displayName)) {
            runtime.commit(event);
          }
          // I2: enforcement lives here, at the server. Not in the UI.
          if (!isDriver(room, participantId)) {
            const holder =
              room.driverId === null ? null : room.participants.get(room.driverId)?.displayName;
            ws.send(
              JSON.stringify({
                kind: 'error',
                message: `You are not driving — ${holder ?? 'someone else'} holds control. Use Request Control.`,
              }),
            );
            return;
          }
          runtime.commit({ type: 'user_prompt', participantId, displayName, text: frame.text });
          runtime.agent.submit(`[${displayName}]: ${frame.text}`);
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
          const accepted = runtime.agent.gate.resolve(frame.requestId, {
            decision: frame.decision,
            participantId,
            displayName,
            via: 'first_response',
            reason: frame.reason ?? null,
          });
          if (!accepted) {
            ws.send(JSON.stringify({ kind: 'error', message: 'That approval was already decided.' }));
          }
          return;
        }

        // --- BEGIN phase-3b interrupt slot: add the `interrupt` frame branch here. ---
        if (frame.kind === 'interrupt') {
          // Deliberately NOT gated on the driver token — this is the safety
          // valve. A runaway agent must not require finding the token holder.
          runtime.commit({ type: 'interrupted', participantId, displayName });
          void runtime.agent.interrupt().catch(() => {
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
      });

      ws.on('close', () => {
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
