import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NexusEvent } from '../protocol/events.js';
import { isLoggedEvent } from '../protocol/events.js';
import { redactEvent } from './redact.js';

const DEFAULT_DATA_DIR = process.env['NEXUS_DATA_DIR'] ?? './data';
const SAFE_ROOM_ID = /^[A-Za-z0-9_-]+$/;

export function logPathFor(roomId: string, dataDir: string = DEFAULT_DATA_DIR): string {
  if (!SAFE_ROOM_ID.test(roomId)) {
    throw new Error(`unsafe room id: ${JSON.stringify(roomId)}`);
  }
  return join(resolve(dataDir), 'rooms', `${roomId}.jsonl`);
}

export class JsonlEventLog {
  readonly path: string;
  #cache: NexusEvent[] | null = null;

  constructor(roomId: string, dataDir: string = DEFAULT_DATA_DIR) {
    this.path = logPathFor(roomId, dataDir);
    mkdirSync(join(resolve(dataDir), 'rooms'), { recursive: true });
  }

  /** Append only. There is deliberately no update, delete, or compact (I3). */
  append(event: NexusEvent): void {
    const redacted = redactEvent(event);
    appendFileSync(this.path, `${JSON.stringify(redacted)}\n`, 'utf8');
    if (this.#cache !== null) this.#cache.push(redacted);
  }

  read(): NexusEvent[] {
    if (this.#cache !== null) return this.#cache;
    this.#cache = existsSync(this.path) ? parseLines(readFileSync(this.path, 'utf8')) : [];
    return this.#cache;
  }

  /** Events strictly after `seq`. Used for resume-from-sequence-number. */
  readFrom(seq: number): NexusEvent[] {
    return this.read().filter((event) => event.seq > seq);
  }

  close(): void {
    this.#cache = null;
  }
}

/** A crash mid-append leaves a partial trailing line. Discard it, don't throw. */
function parseLines(raw: string): NexusEvent[] {
  const events: NexusEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isLoggedEvent(parsed)) events.push(parsed);
  }
  return events;
}

export function openLog(roomId: string, dataDir: string = DEFAULT_DATA_DIR): JsonlEventLog {
  return new JsonlEventLog(roomId, dataDir);
}
