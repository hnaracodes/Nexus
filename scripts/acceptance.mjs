#!/usr/bin/env node
/**
 * Live acceptance harness — real WebSockets against a real server.
 *
 * The centrepiece is the I2' bypass check. That invariant says attribution and
 * driver status are decided BY THE SERVER and cannot be forged by a client, and
 * CLAUDE.md is explicit about how to test it: "send a raw WebSocket frame from
 * the browser console — forged `wasDriver: true` must come back logged
 * `false`." Node's global WebSocket is the same API that browser console has,
 * so a forgery attempted here is the same forgery a participant can attempt.
 *
 * No API key is needed: the server commits `user_prompt` on receipt, before the
 * agent is ever consulted, so attribution is decided and logged whether or not
 * the agent can run.
 *
 * Usage: node scripts/acceptance.mjs [port]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { connect } from 'node:net';
import { WebSocket } from 'ws';

const PORT = Number(process.argv[2] ?? 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const WSBASE = BASE.replace('http', 'ws');
const KEY = 'sk-ant-api03-ACCEPTANCE-not-a-real-key';
const DATA_DIR = mkdtempSync(pathJoin(tmpdir(), 'nexus-acceptance-'));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${ok || detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port) {
  return new Promise((resolve) => {
    const s = connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 500);
  });
}

// Same refusal as the restart harness, for the same reason: results describing
// somebody else's server are worse than no results.
if (await portOpen(PORT)) {
  console.error(`ACCEPTANCE FAIL: something is already listening on ${PORT}. Refusing to run.`);
  console.error(`Find it with:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
  process.exit(2);
}

const server = spawn(process.execPath, ['apps/server/dist/server/index.js'], {
  env: { ...process.env, PORT: String(PORT), NEXUS_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let bootErr = '';
server.stderr.on('data', (d) => { bootErr += String(d); });
server.once('exit', (code) => {
  if (server.__expected) return;
  console.error(`ACCEPTANCE FAIL: server exited early (code ${code}).`);
  if (bootErr.trim()) console.error(bootErr.trim().split('\n').slice(0, 6).join('\n'));
  process.exit(2);
});

const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  if ((await fetch(`${BASE}/healthz`).catch(() => null))?.ok) break;
  await sleep(200);
}
console.log(`acceptance — port ${PORT}\n`);

const { roomId, token } = await fetch(`${BASE}/api/rooms`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ apiKey: KEY }),
}).then((r) => r.json());

/** A joined participant, with every frame it received. */
async function join(name) {
  const socket = new WebSocket(`${WSBASE}/ws?room=${roomId}&token=${token}&name=${name}`);
  const frames = [];
  socket.on('message', (d) => frames.push(JSON.parse(String(d))));
  await new Promise((res, rej) => { socket.once('open', res); socket.once('error', rej); });
  await sleep(300);
  const me = frames.find((f) => f.kind === 'replay_complete');
  return { socket, frames, participantId: me?.participantId, send: (o) => socket.send(JSON.stringify(o)) };
}

const ada = await join('Ada');
const bo = await join('Bo');
await sleep(300);

/**
 * ESTABLISH A DRIVER FIRST. This ordering is the entire point of the test.
 *
 * The first version of this harness forged `wasDriver: true` from Bo into an
 * IDLE room — and it came back logged `true`, which looked like an I2' breach
 * and was not. `index.ts` claims the token for the first speaker in an idle
 * room ("First speaker in an idle room claims the token"), so Bo genuinely
 * WAS the driver by the time the flag was computed. The forged value happened
 * to match the truth, which makes the test worthless: it cannot tell a
 * rejected forgery from an honoured one. A right assertion at the wrong
 * moment, which is the recurring defect shape this repo mutation-tests for.
 *
 * With Ada holding the token, Bo's claim of `true` is a claim the server must
 * contradict — and only then does the assertion mean anything.
 */
console.log('establishing a driver:\n');
ada.send({ kind: 'request_control' });
await sleep(600);
// Asserted on the LOGGED event, not on the transient `presence` frame.
// `presence` is a snapshot broadcast whose latest copy a client may hold from
// before the grant; the log is the authoritative record (I3), and reading the
// transient view here produced a false FAIL while the assertions below proved
// the token had in fact been granted.
const granted = [...ada.frames]
  .filter((f) => f.kind === 'event' && f.event?.type === 'driver_granted')
  .map((f) => f.event);
check('an uncontested request_control grants the token',
  granted.some((e) => e.participantId === ada.participantId),
  `driver_granted events: ${JSON.stringify(granted.map((e) => e.displayName))}`);

console.log("\nI2' — the server decides attribution, not the client:\n");

/**
 * THE FORGERY. Exactly what a participant can type into a browser console:
 * extra fields bolted onto a legitimate frame, claiming the token and claiming
 * to be someone else.
 */
bo.send({
  kind: 'prompt',
  text: 'forged frame from Bo',
  wasDriver: true,                  // Bo does NOT hold the token — Ada does
  participantId: ada.participantId, // and Bo is not Ada
  displayName: 'Ada',
});
await sleep(700);

const logged = [...ada.frames, ...bo.frames]
  .filter((f) => f.kind === 'event' && f.event?.type === 'user_prompt')
  .map((f) => f.event)
  .filter((e) => e.text === 'forged frame from Bo');

check("the forged prompt was ADMITTED (I2' is precedence, not admission)", logged.length > 0,
  'no user_prompt was logged at all');

const forged = logged[0];
check('forged `wasDriver: true` is logged as FALSE', forged?.wasDriver === false,
  `logged wasDriver=${JSON.stringify(forged?.wasDriver)}`);
check("forged `participantId` is ignored — the socket's identity wins",
  forged?.participantId === bo.participantId,
  `logged ${forged?.participantId}, socket is ${bo.participantId}`);
check('forged `displayName` is ignored', forged?.displayName === 'Bo',
  `logged ${JSON.stringify(forged?.displayName)}`);

check('a non-driver is still ADMITTED while someone else drives (open floor)',
  forged !== undefined);

ada.send({ kind: 'prompt', text: 'ada speaks while driving' });
await sleep(600);
const adaPrompt = [...ada.frames]
  .filter((f) => f.kind === 'event' && f.event?.type === 'user_prompt')
  .map((f) => f.event).find((e) => e.text === 'ada speaks while driving');
check('the real driver IS logged wasDriver=true', adaPrompt?.wasDriver === true,
  `logged ${JSON.stringify(adaPrompt?.wasDriver)}`);

console.log('\nthe wire refuses what it should:\n');

const before = bo.frames.length;
bo.send({ kind: 'stop_agent' }); // no agentId — must be REFUSED, not defaulted
await sleep(400);
const errored = bo.frames.slice(before).some((f) => f.kind === 'error');
check('`stop_agent` with no agentId is refused, never defaulted to primary', errored,
  'the server accepted it silently');

const noToken = await fetch(`${BASE}/api/rooms/${roomId}/configs`);
check('a room-scoped config route refuses a request with no token', noToken.status === 401,
  `got ${noToken.status}`);

ada.socket.close(); bo.socket.close();
await sleep(200);
server.__expected = true;
server.kill('SIGTERM');
await sleep(500);
if (await portOpen(PORT)) server.kill('SIGKILL');
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
