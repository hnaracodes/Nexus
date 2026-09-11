#!/usr/bin/env node
// Verifies that a deployed SynCode can create a room over HTTPS and that a
// WebSocket upgrade survives the platform proxy. Usage:
//   node scripts/smoke-ws.mjs https://nexus-mvp.fly.dev
import { WebSocket } from 'ws';

const base = process.argv[2];
if (base === undefined) {
  console.error('usage: node scripts/smoke-ws.mjs <base-url>');
  process.exit(1);
}

// Syntactically valid but non-functional: room creation only validates the
// prefix, and this smoke test never asks the agent to do anything.
const PLACEHOLDER_KEY = 'sk-ant-api03-SMOKETEST-not-a-real-key';

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  process.exit(1);
}

const health = await fetch(`${base}/healthz`).catch((error) =>
  fail(`/healthz unreachable: ${error}`),
);
if (!health.ok) fail(`/healthz returned ${health.status}`);

const created = await fetch(`${base}/api/rooms`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ apiKey: PLACEHOLDER_KEY }),
});
if (!created.ok) fail(`POST /api/rooms returned ${created.status}`);

const { roomId, token } = await created.json();
if (typeof roomId !== 'string' || typeof token !== 'string') {
  fail('POST /api/rooms did not return roomId and token');
}

const wsBase = base.replace(/^http/, 'ws');
const socket = new WebSocket(`${wsBase}/ws?room=${roomId}&token=${token}&name=smoke`);

const outcome = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ ok: false, why: 'no frame within 10s' }), 10_000);
  socket.on('message', (data) => {
    clearTimeout(timer);
    resolve({ ok: true, first: JSON.parse(String(data)) });
  });
  socket.on('error', (error) => {
    clearTimeout(timer);
    resolve({ ok: false, why: `socket error: ${error.message}` });
  });
  socket.on('close', (code) => {
    clearTimeout(timer);
    resolve({ ok: false, why: `closed before any frame (code ${code})` });
  });
});

socket.close();

if (!outcome.ok) fail(`websocket upgrade did not survive the proxy — ${outcome.why}`);

console.log(`SMOKE OK: room ${roomId}, first frame kind="${outcome.first.kind}"`);
process.exit(0);
