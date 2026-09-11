import type { SynCodeEvent } from '@syncode/protocol/events';
import { JsonlEventLog } from './event-log.js';

/** Structurally identical to the EventSink interface in src/server/ws.ts. */
export interface EventSink {
  append(event: SynCodeEvent): void;
  read(): SynCodeEvent[];
}

export function createSink(roomId: string, dataDir?: string): JsonlEventLog {
  return dataDir === undefined ? new JsonlEventLog(roomId) : new JsonlEventLog(roomId, dataDir);
}

export { JsonlEventLog, logPathFor, openLog } from './event-log.js';
export { redactEvent, redactString } from './redact.js';
