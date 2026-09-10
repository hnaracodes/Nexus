/**
 * The wire format for one collaborative-document sync payload.
 *
 * THIS FILE EXISTS BECAUSE THE TWO SIDES DISAGREED. The server encoded a flat
 * bundle of Automerge changes; the browser client spoke Automerge's official
 * sync protocol (`generateSyncMessage` / `receiveSyncMessage`). Both were
 * internally coherent, both were carefully argued in their own comments, both
 * were fully tested — and they could not talk to each other, because each
 * side's tests only ever spoke to itself. Collaborative editing was green on
 * both ends and broken in the middle.
 *
 * So the format now lives in the protocol package, beside the frames that
 * carry it, and both sides import THIS. A format defined twice is a format
 * that will drift; this is the same reason `events.ts` says never to copy its
 * types.
 *
 * THE FORMAT: a JSON array of base64 Automerge changes, itself base64-encoded,
 * so every payload — the initial one from `open()`, an incoming edit, an
 * outgoing broadcast — is a single opaque string, matching what `doc_sync` and
 * `MAX_DOC_PAYLOAD_CHARS` already assume.
 *
 * Deliberately NOT Automerge's sync protocol. That protocol earns its keep
 * between peers who already share most of a large document's history and
 * cannot afford to resend it — a real cost in a browser-to-browser mesh, and
 * not this shape. Here the server holds the one authoritative copy every peer
 * syncs against, and every payload fits comfortably under
 * `MAX_DOC_PAYLOAD_CHARS`. A flat bundle needs no per-peer state machine to
 * get wrong, and is exactly as correct: Automerge changes merge the same way
 * regardless of the envelope they arrive in.
 *
 * `btoa`/`atob` rather than `Buffer`: this module is imported by the BROWSER
 * client as well as the server, and reaching for `Buffer` is what would
 * quietly push the format back into being server-only. Both are global in
 * Node 18+ and in every browser.
 */

function toBase64(bytes: Uint8Array): string {
  // Built with a loop rather than `String.fromCharCode(...bytes)`: spreading a
  // large payload into an argument list overflows the stack, and a sync bundle
  // is allowed to approach a megabyte.
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function encodeChangeBundle(changes: readonly Uint8Array[]): string {
  return btoa(JSON.stringify(changes.map(toBase64)));
}

export function decodeChangeBundle(payloadBase64: string): Uint8Array[] {
  const parsed = JSON.parse(atob(payloadBase64)) as string[];
  return parsed.map(fromBase64);
}
