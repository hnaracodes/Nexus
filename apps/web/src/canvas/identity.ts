/**
 * The participant identities this browser holds for a room.
 *
 * Driver-only REST routes (running a workflow) have no socket to read WHO is
 * calling from, so the caller presents the same participant id + resume secret
 * the WebSocket reconnect path already uses (`ws.ts` stores them under
 * `nexus:identity:<room>:<name>`). Two people sharing one browser profile hold
 * two identities for one room; `api.run` tries each until the server accepts.
 *
 * The secret goes in a request header, never a URL, and is never logged (I4).
 */
export interface Identity {
  participantId: string;
  resumeToken: string;
}

export function readStoredIdentities(roomId: string): Identity[] {
  const prefix = `nexus:identity:${roomId}:`;
  const found: Identity[] = [];
  try {
    const storage = globalThis.localStorage;
    if (storage === undefined) return found;
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key === null || !key.startsWith(prefix)) continue;
      const parsed = JSON.parse(storage.getItem(key) ?? 'null') as Partial<Identity> | null;
      if (parsed !== null && typeof parsed.participantId === 'string' && typeof parsed.resumeToken === 'string') {
        found.push({ participantId: parsed.participantId, resumeToken: parsed.resumeToken });
      }
    }
  } catch {
    // Storage blocked or corrupt: no identity to offer. The server will say
    // plainly that only the driver can run a workflow.
  }
  return found;
}
