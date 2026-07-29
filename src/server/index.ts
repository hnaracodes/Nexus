import type { Server } from 'node:http';
import { createAdaptorServer } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '../protocol/events.js';
import { parseClientFrame } from '../protocol/wire.js';
import { authorize, createRoom, getRoom } from './rooms.js';
import { attachRoom, getRuntime, newParticipantId } from './ws.js';

export function createServer(): { app: Hono; server: Server } {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.post('/api/rooms', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { apiKey?: string; repoUrl?: string | null; cwd?: string }
      | null;
    const apiKey = body?.apiKey;
    if (typeof apiKey !== 'string' || !apiKey.startsWith('sk-ant-')) {
      // Do not echo what was received — it may be a real key.
      return c.json({ error: 'An Anthropic Console API key (sk-ant-...) is required.' }, 400);
    }
    const room = createRoom({
      apiKey,
      cwd: body?.cwd ?? process.cwd(),
      repoUrl: body?.repoUrl ?? null,
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
      const runtime = getRuntime(room.id) ?? attachRoom(room);
      const participantId = newParticipantId();

      // Replay first, then attach. Order matters: attaching before replay
      // finishes interleaves history with live events.
      for (const event of runtime.sink.read()) {
        ws.send(JSON.stringify({ kind: 'event', event }));
      }
      ws.send(
        JSON.stringify({
          kind: 'replay_complete',
          lastSeq: room.peekSeq(),
          protocolVersion: PROTOCOL_VERSION,
        }),
      );

      runtime.addSocket(ws, participantId);
      room.participants.set(participantId, { id: participantId, displayName, connected: true });
      runtime.commit({ type: 'participant_joined', participantId, displayName });

      ws.on('message', (data) => {
        const frame = parseClientFrame(String(data));
        if (frame === null) {
          ws.send(JSON.stringify({ kind: 'error', message: 'Unrecognized message.' }));
          return;
        }
        if (frame.kind === 'prompt') {
          // Phase 0 has no driver gate. Plan phase-2a inserts the I2 check here.
          runtime.commit({ type: 'user_prompt', participantId, displayName, text: frame.text });
          runtime.agent.submit(`[${displayName}]: ${frame.text}`);
        }
      });

      ws.on('close', () => {
        runtime.removeSocket(ws);
        const participant = room.participants.get(participantId);
        if (participant !== undefined) participant.connected = false;
        runtime.commit({ type: 'participant_left', participantId, displayName });
      });
    });
  });

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
