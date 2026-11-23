/**
 * Phase 17c — the parse/copy decisions behind "Open a folder" and "Share on
 * Local Network", pulled out of `main.ts` for the same reason `launcher.ts`
 * documents at its own top: a decision this security-relevant has to be
 * testable without launching Electron, so `main.ts` stays glue.
 *
 * Nothing here decides WHICH folder gets opened or WHETHER to actually
 * rebind the listener — those are `main.ts`'s job, driven by a real OS
 * dialog and a real user click. This module only builds the strings that
 * decision is made from, and the one filesystem-free fact ("what are this
 * machine's LAN addresses") that both the confirmation copy and the actual
 * rebind decision need to agree on.
 */

import { networkInterfaces } from 'node:os';
import { basename } from 'node:path';

/** A folder's name for display — never used for anything security-relevant;
 *  the REAL path main.ts acts on is remembered server-side of the IPC
 *  boundary (see main.ts's `pendingFolderPath`), never re-derived from this. */
export function folderDisplayName(absolutePath: string): string {
  const name = basename(absolutePath);
  return name === '' ? absolutePath : name;
}

/**
 * CLAUDE.md §11's required on-screen consent, verbatim: "If the agent runs
 * locally, 'shared room is a shared boundary' becomes 'shared room is a
 * shared boundary on my laptop.' That is a far stronger claim to make to a
 * user and must be surfaced in the UI, not the README." This is that text —
 * a pure function so the copy is unit-tested rather than only eyeballed in a
 * running app, and so it cannot silently drift from what CLAUDE.md requires.
 */
export function folderConsentMessage(absolutePath: string): string {
  return (
    `Everyone you invite to this room can read and change every file in ` +
    `${absolutePath}, and can ask an agent to run commands in it. There is ` +
    `no per-person permission. Only invite people you would give your laptop to.`
  );
}

/**
 * The exact joinable link, named on screen once the room exists — the
 * loopback half of "Share this room": a link that opens this same room from
 * another window or a plain browser tab on this machine.
 */
export function roomReadyMessage(joinUrl: string): string {
  return `Room ready. To open it from a browser on this machine:\n\n${joinUrl}`;
}

/**
 * This machine's non-loopback IPv4 addresses — the interfaces a LAN-sharing
 * confirmation must name (CLAUDE.md: "needs its own second confirmation
 * naming the interface and address, because that changes who can reach the
 * port at all"). IPv4 only, deliberately: it is the address family a person
 * can read off a router admin page and type into another device with no
 * ambiguity, which is the whole point of naming it.
 */
export function localNetworkAddresses(): string[] {
  const addresses: string[] = [];
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces).sort()) {
    for (const info of interfaces[name] ?? []) {
      if (info.family === 'IPv4' && !info.internal) addresses.push(info.address);
    }
  }
  return addresses;
}

/**
 * The text shown before a room goes from loopback-only to reachable on the
 * LAN — the "own second confirmation" CLAUDE.md requires, naming every
 * address this room would become reachable at and the port, and stating
 * plainly that the connection is unencrypted HTTP so the room token is the
 * only thing standing between anyone on that network and the room.
 */
export function lanShareConfirmMessage(addresses: string[], port: number): string {
  if (addresses.length === 0) {
    return (
      'No network address was found for this machine, so there is nothing to ' +
      'share it at. Connect to a network and try again.'
    );
  }
  const urls = addresses.map((address) => `http://${address}:${port}`).join('\n');
  return (
    `Anyone who can reach one of these addresses on your network will be able ` +
    `to open this room, see every file, ask the agent to run commands, and open ` +
    `a terminal to run commands on this computer themselves, as you — the same ` +
    `access as you have, with no per-person permission:\n\n${urls}\n\n` +
    `This is plain HTTP: the room token is the only credential, and it would ` +
    `travel unencrypted on this network. Only continue on a network you trust.`
  );
}

/**
 * Phase 20. A link someone ELSE can open: only `room` and `token` — never the
 * host's `name`, which would make the recipient join under the host's name.
 */
export function roomJoinUrl(origin: string, roomId: string, token: string): string {
  return `${origin}/?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`;
}

/**
 * One full, joinable link per LAN address. The LAN dialog used to show bare
 * `http://<ip>:<port>` origins, which open the landing page, not the room.
 */
export function lanRoomLinks(addresses: string[], port: number, roomId: string, token: string): string[] {
  return addresses.map((address) => roomJoinUrl(`http://${address}:${port}`, roomId, token));
}

export const DEFAULT_RELAY_URL = 'https://nexus-mvp.fly.dev';

/**
 * Where "Share on the Web" connects. `SYNCODE_RELAY_URL` (then the legacy
 * `NEXUS_RELAY_URL`) overrides the hosted relay. Plain http is accepted only
 * for this machine — a local relay while developing — because the room token
 * crosses that connection on every guest request.
 */
export function relayUrlFromEnv(env: Record<string, string | undefined>): string {
  const raw = env['SYNCODE_RELAY_URL'] ?? env['NEXUS_RELAY_URL'];
  if (raw === undefined || raw === '') return DEFAULT_RELAY_URL;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return url.origin;
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (url.protocol === 'http:' && loopback) return url.origin;
  } catch {
    // fall through to the default
  }
  return DEFAULT_RELAY_URL;
}

/** The consent text before a room goes onto the internet. Says the hard parts plainly. */
export function webShareConfirmMessage(relayUrl: string): string {
  const host = new URL(relayUrl).host;
  return (
    `Anyone with the link will be able to open this room from anywhere on the ` +
    `internet, see every file, ask the agent to run commands, and open a ` +
    `terminal that runs commands on this computer as you — the same access ` +
    `you have, with no per-person permission. You can switch the terminal off ` +
    `in the room, and stop sharing from the Room menu at any time.\n\n` +
    `The connection goes through SynCode's relay at ${host}. It is encrypted ` +
    `in transit, but it is not end-to-end: the relay can see the room's ` +
    `traffic. Only send the link to people you trust.`
  );
}
