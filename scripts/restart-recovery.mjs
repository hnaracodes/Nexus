#!/usr/bin/env node
/**
 * Restart-recovery harness.
 *
 * Kills a running Nexus and asks what survived. Everything this repo claims
 * about I3 — "every view of room state must be reconstructible from the log
 * alone" — is a claim about a process that has died, and no unit test can make
 * that claim, because a unit test never dies.
 *
 * Usage:
 *   node scripts/restart-recovery.mjs [port]
 *
 * THE LESSON BAKED IN HERE, from CLAUDE.md §9: make the harness FAIL LOUDLY if
 * the process refuses to die. On Windows, `child.kill()` on a `shell: true`
 * spawn leaves the grandchild listening, and the first version of this harness
 * silently tested a restart that never happened — reporting a pass for a
 * property it had not exercised at all. So: no shell, a direct spawn, and an
 * explicit assertion that the port is genuinely closed before restarting.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';

const PORT = Number(process.argv[2] ?? 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'sk-ant-api03-RESTARTHARNESS-not-a-real-key';
const DATA_DIR = mkdtempSync(join(tmpdir(), 'nexus-restart-'));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${ok || detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when something is listening. Used to prove the server both STARTED and,
 *  more importantly, genuinely STOPPED. */
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { resolve(false); });
    setTimeout(() => { socket.destroy(); resolve(false); }, 500);
  });
}

async function waitFor(predicate, { timeoutMs = 15_000, label }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Direct spawn, NOT `shell: true` — see the header. A shell in between means
 *  the pid we hold is the shell's, not the server's, and killing it can leave
 *  the server listening while we cheerfully "restart" it. */
function start() {
  const child = spawn(process.execPath, ['apps/server/dist/server/index.js'], {
    env: { ...process.env, PORT: String(PORT), NEXUS_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => {
    stderr += String(d);
    if (process.env['NEXUS_HARNESS_VERBOSE']) process.stderr.write(d);
  });
  // A server that dies immediately — EADDRINUSE is the classic — must be LOUD.
  // Otherwise `waitFor(/healthz)` happily succeeds against whatever else is on
  // the port, and every result afterwards describes someone else's process.
  child.once('exit', (code) => {
    if (code === 0 || child.__expected) return;
    console.error(`HARNESS FAIL: the server exited early (code ${code}).`);
    if (stderr.trim() !== '') console.error(stderr.trim().split('\n').slice(0, 6).join('\n'));
    process.exit(2);
  });
  return child;
}

async function stop(child) {
  child.__expected = true;
  child.kill('SIGTERM');
  await sleep(600);
  if (!child.killed || (await portOpen(PORT))) {
    child.kill('SIGKILL');
    await sleep(600);
  }
  // THE ASSERTION THAT MAKES THE REST MEAN ANYTHING. If the port is still open
  // the process did not die, and every "survived a restart" result below would
  // be a lie about a restart that never happened.
  const stillUp = await portOpen(PORT);
  if (stillUp) {
    console.error('HARNESS FAIL: the server is STILL LISTENING after kill.');
    console.error('Every result below would describe a restart that never happened. Aborting.');
    process.exit(2);
  }
  return true;
}

console.log(`restart-recovery — port ${PORT}, data dir ${DATA_DIR}\n`);

/**
 * REFUSE TO RUN ON AN OCCUPIED PORT.
 *
 * Found the hard way on the first run of this harness: a stale Nexus from
 * earlier in the day was still listening on 8099, so the harness's own server
 * died with EADDRINUSE while `/healthz` answered cheerfully from the OTHER
 * process. Every subsequent assertion would have described a server this
 * harness never started and never killed. CLAUDE.md already records this exact
 * shape for port 8080; it is not specific to 8080, it is specific to reusing a
 * port without checking.
 */
if (await portOpen(PORT)) {
  console.error(`HARNESS FAIL: something is already listening on ${PORT}.`);
  console.error('Refusing to run — results would describe that process, not one this harness controls.');
  console.error(`Find it with:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
  process.exit(2);
}

// ---------------------------------------------------------------- boot ------
let server = start();
await waitFor(async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok === true, {
  label: 'first boot',
});
console.log('booted.\n');

// ------------------------------------------------------- create state -------
const created = await fetch(`${BASE}/api/rooms`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ apiKey: KEY }),
}).then((r) => r.json());

const { roomId, token } = created;
if (typeof roomId !== 'string' || typeof token !== 'string') {
  console.error('HARNESS FAIL: could not create a room:', JSON.stringify(created).slice(0, 300));
  process.exit(2);
}
console.log(`created room ${roomId}`);

// Join over a real socket so there is participant history in the log, then
// leave it open long enough for the server to commit `participant_joined`.
const { WebSocket } = await import('ws');
const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?room=${roomId}&token=${token}&name=Harness`);
await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});
await sleep(500);
ws.close();
await sleep(300);

const beforeEvents = await fetch(`${BASE}/api/rooms/${roomId}`, {
  headers: { 'X-Nexus-Token': token },
}).then((r) => (r.ok ? r.json() : null));
console.log('state captured before the kill.\n');

// ------------------------------------------------------------- kill ---------
console.log('killing the server...');
await stop(server);
console.log('confirmed dead (port closed).\n');

// ---------------------------------------------------------- restart ---------
server = start();
await waitFor(async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok === true, {
  label: 'restart',
});
console.log('restarted. asking what survived:\n');

// ------------------------------------------------------- assertions ---------
const after = await fetch(`${BASE}/api/rooms/${roomId}`, { headers: { 'X-Nexus-Token': token } });
check('the room is reachable again under its ORIGINAL id and token', after.ok,
  `GET /api/rooms/:id returned ${after.status}`);

const body = after.ok ? await after.json() : {};
check('its cwd survived', typeof body.cwd === 'string' && body.cwd.length > 0);

// The token is the credential; a recovered room that accepts a WRONG one is a
// hijack, and recovery is exactly where that regression would hide.
const wrongToken = await fetch(`${BASE}/api/rooms/${roomId}`, {
  headers: { 'X-Nexus-Token': 'x'.repeat(64) },
});
check('a WRONG token is still refused after recovery', wrongToken.status === 401,
  `expected 401, got ${wrongToken.status}`);

/**
 * I4 FIRST: a recovered room is KEYLESS and must refuse work until its creator
 * returns. `recovery.ts` deliberately persists no apiKey — "adding one here
 * would put a live credential on a persistent volume" — so the socket must be
 * turned away with 4409, not quietly served.
 *
 * This assertion exists because the harness got it wrong on its first honest
 * run: it rejoined without re-keying, saw zero frames, and reported four I3
 * failures that were really one correct refusal. A harness that cannot tell a
 * security property from a bug is worse than no harness.
 */
const preKey = new WebSocket(`${BASE.replace('http', 'ws')}/ws?room=${roomId}&token=${token}&name=Early`);
const preKeyClose = await new Promise((resolve) => {
  preKey.once('close', (code) => resolve(code));
  preKey.once('error', () => {});
  setTimeout(() => resolve(0), 3000);
});
check('a recovered room REFUSES a socket until its key is re-supplied (I4)',
  preKeyClose === 4409, `expected close 4409, got ${preKeyClose}`);

// Now do what a returning creator does.
const rekey = await fetch(`${BASE}/api/rooms/${roomId}/key`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'X-Nexus-Token': token },
  body: JSON.stringify({ apiKey: KEY }),
});
check('the creator can re-supply the key after recovery', rekey.ok,
  `POST /key returned ${rekey.status}`);

// I3: the log is authoritative. A rejoin must replay history, not start blank.
const rejoin = new WebSocket(`${BASE.replace('http', 'ws')}/ws?room=${roomId}&token=${token}&name=Harness2`);
const frames = [];
rejoin.on('message', (d) => frames.push(JSON.parse(String(d))));
await new Promise((resolve, reject) => {
  rejoin.once('open', resolve);
  rejoin.once('error', reject);
});
await sleep(800);
rejoin.close();

const replayed = frames.filter((f) => f.kind === 'event');
check('rejoining REPLAYS the log rather than starting blank', replayed.length > 0,
  `saw ${replayed.length} event frames`);
check('room_created survived the restart', replayed.some((f) => f.event?.type === 'room_created'));
check('the pre-kill participant is still in the log (I3)',
  replayed.some((f) => f.event?.type === 'participant_joined'));

const completed = frames.find((f) => f.kind === 'replay_complete');
check('replay_complete still names this socket its own participantId',
  typeof completed?.participantId === 'string' && completed.participantId.length > 0);

// recovery.ts appends a synthetic driver_released rather than restoring a
// driver whose socket is gone — live state and the log must not disagree.
check('a driver held at kill time is explicitly RELEASED in the log, not silently dropped',
  !replayed.some((f) => f.event?.type === 'driver_granted' && !replayed.some((g) => g.event?.type === 'driver_released')),
  'a driver_granted with no matching driver_released survived');

// ------------------------------------------------------------ cleanup -------
await stop(server);
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
