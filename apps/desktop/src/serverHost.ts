import type { AddressInfo } from 'node:net';

/**
 * `http.Server#listen(0, …)` hands port selection to the OS — deliberately.
 * CLAUDE.md already documents that port 8080 is occupied on the primary dev
 * machine by an unrelated process; a desktop app installed on an arbitrary
 * user's machine has even less basis to assume any fixed port is free, and
 * unlike the Fly deployment there is no operator picking one in advance. The
 * only way back to whichever port the OS actually handed out is
 * `server.address()`, read once the 'listening' event has fired.
 *
 * Its return type is deliberately wide (`AddressInfo | string | null`)
 * because the same method also serves Unix domain sockets (a `string` path)
 * and a server that has not started listening yet, or has already closed
 * (`null`). This narrows it to the one shape actually usable here and throws
 * with a message naming what went wrong, rather than letting a caller
 * dereference `.port` on a string or null and get a confusing TypeError two
 * frames away from the real cause.
 */
export function resolveListenPort(address: AddressInfo | string | null): number {
  if (address === null) {
    throw new Error(
      'Server is not listening — call resolveListenPort only after the "listening" event fires.',
    );
  }
  if (typeof address === 'string') {
    throw new Error(`Expected a TCP address with a port, got a pipe/socket path: ${address}`);
  }
  return address.port;
}

/**
 * 127.0.0.1, not "localhost" or "0.0.0.0": the server exists to be reached by
 * this one Electron window and nothing else — never by another device on the
 * LAN. Resolving the name "localhost" can round-trip through a system's
 * hosts file, or on some Windows configurations resolve to IPv6 first, in a
 * way that does not necessarily match whichever interface the server bound.
 * Binding and browsing the same literal address sidesteps both failure
 * modes.
 */
export function serverOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}
