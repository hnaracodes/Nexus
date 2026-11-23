/**
 * Phase 21 — turns the model's raw stream (`stream_event` SDK messages, with
 * `includePartialMessages: true`) into what the room watches live:
 *   - chat text as `assistant_delta`, keyed by the message id the logged
 *     `assistant_message` will carry (the client already folds these);
 *   - Edit / MultiEdit / Write calls as edit previews (`livepreview.ts`), typed
 *     out at the right place while the model is still generating them.
 *
 * Everything here is TRANSIENT (I3) and runs through `StreamRedactor` first, so a
 * secret the agent types is scrubbed whole before any client sees it.
 *
 * Pure apart from the sink: no SDK import, no timers, no I/O.
 */
import type { AgentId } from '@syncode/protocol/events';
import { applyLiveFrame, PREVIEW_TOOLS } from '@syncode/protocol/livepreview';
import type { EditPreview, LiveFrame, PreviewTool } from '@syncode/protocol/livepreview';
import { redactString } from '../../log/redact.js';
import { PartialJsonScanner } from './partialJson.js';
import type { JsonPath } from './partialJson.js';
import { StreamRedactor } from './streamRedactor.js';

export type LiveOutFrame = LiveFrame | { kind: 'assistant_delta'; messageId: string; text: string };
export type LiveSink = (frame: LiveOutFrame) => void;

export interface LiveStream {
  /** Feed EVERY SDK message; anything but `stream_event` is ignored. */
  onSdkMessage(message: unknown): void;
  /** The turn ended or was interrupted: anything still being typed never happened. */
  abandonAll(): void;
  /** Previews still being generated — what a socket joining now must be shown. */
  inFlight(): EditPreview[];
}

export const DEFAULT_MAX_PREVIEW_BYTES = 256 * 1024;

interface TextBlock {
  kind: 'text';
  redactor: StreamRedactor;
}
interface ToolBlock {
  kind: 'tool';
  toolUseId: string;
  scanner: PartialJsonScanner;
  /** Per streamed field (by path key): its redactor, and where its text goes. */
  fields: Map<string, { redactor: StreamRedactor; hunk: number; field: 'old' | 'new' } | { path: true; raw: string }>;
  bytes: number;
}
type Block = TextBlock | ToolBlock | { kind: 'ignored' };

interface Stream {
  messageId: string | null;
  blocks: Map<number, Block>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Where a streamed string field of a file tool's input goes. */
function target(path: JsonPath): { hunk: number; field: 'old' | 'new' } | 'path' | null {
  if (path.length === 1) {
    if (path[0] === 'file_path') return 'path';
    if (path[0] === 'old_string') return { hunk: 0, field: 'old' };
    if (path[0] === 'new_string' || path[0] === 'content') return { hunk: 0, field: 'new' };
    return null;
  }
  if (path.length === 3 && path[0] === 'edits' && typeof path[1] === 'number') {
    if (path[2] === 'old_string') return { hunk: path[1], field: 'old' };
    if (path[2] === 'new_string') return { hunk: path[1], field: 'new' };
  }
  return null;
}

export function createLiveStream(opts: { agentId: AgentId; sink: LiveSink; maxPreviewBytes?: number }): LiveStream {
  const maxBytes = opts.maxPreviewBytes ?? DEFAULT_MAX_PREVIEW_BYTES;
  /** Keyed by parent tool-use id ('' = top level): a subagent streams separately. */
  const streams = new Map<string, Stream>();
  /**
   * Message ids whose COMPLETE `assistant` message has already arrived. The
   * real CLI sends that before the stream's `content_block_stop`, so the word a
   * text redactor still holds must not be released after it: the logged message
   * has already replaced the stream, and a late tail would sit in chat as an
   * orphan bubble (seen in the first real-model run).
   */
  const completeMessages = new Set<string>();
  /** The server's own fold of what it sent, so a joiner's snapshot is exact. */
  let previews: Record<string, EditPreview> = {};

  function send(frame: LiveFrame): void {
    previews = applyLiveFrame(previews, frame);
    if (frame.kind === 'edit_preview_end') {
      // Complete or abandoned, the server is done with it: the log takes over.
      const { [frame.toolUseId]: _done, ...rest } = previews;
      previews = rest;
    }
    opts.sink(frame);
  }

  function snapshot(toolUseId: string, change: Partial<EditPreview>): void {
    const current = previews[toolUseId];
    if (current === undefined) return;
    send({ kind: 'edit_preview', preview: { ...current, ...change } });
  }

  function append(block: ToolBlock, hunk: number, field: 'old' | 'new', text: string): void {
    if (text === '') return;
    const preview = previews[block.toolUseId];
    if (preview === undefined || preview.truncated) return;
    if (block.bytes + text.length > maxBytes) {
      const room = Math.max(0, maxBytes - block.bytes);
      if (room > 0) send({ kind: 'edit_preview_text', toolUseId: block.toolUseId, hunk, field, text: text.slice(0, room) });
      block.bytes = maxBytes;
      snapshot(block.toolUseId, { truncated: true });
      return;
    }
    block.bytes += text.length;
    send({ kind: 'edit_preview_text', toolUseId: block.toolUseId, hunk, field, text });
  }

  function onToolJson(block: ToolBlock, partial: string): void {
    for (const e of block.scanner.push(partial)) {
      const key = JSON.stringify(e.path);
      if (e.type === 'scalar') {
        const last = e.path[e.path.length - 1];
        if (last === 'replace_all' && e.value === true && previews[block.toolUseId]?.replaceAll !== true) {
          snapshot(block.toolUseId, { replaceAll: true });
        }
        continue;
      }
      const where = target(e.path);
      if (where === null) continue;
      if (e.type === 'string_start') {
        block.fields.set(key, where === 'path' ? { path: true, raw: '' } : { redactor: new StreamRedactor(), ...where });
        continue;
      }
      const field = block.fields.get(key);
      if (field === undefined) continue;
      if ('path' in field) {
        if (e.type === 'string_append') field.raw += e.text;
        else snapshot(block.toolUseId, { path: redactString(field.raw) });
        continue;
      }
      if (e.type === 'string_append') {
        append(block, field.hunk, field.field, field.redactor.push(e.text));
      } else {
        append(block, field.hunk, field.field, field.redactor.flush());
        if (field.field === 'old') {
          // Placement switches from "prefix so far" to "exact match" here.
          const current = previews[block.toolUseId];
          if (current !== undefined) {
            const hunks = current.hunks.map((h, i) => (i === field.hunk ? { ...h, oldDone: true } : h));
            snapshot(block.toolUseId, { hunks });
          }
        }
      }
    }
  }

  function endBlock(stream: Stream, index: number): void {
    const block = stream.blocks.get(index);
    stream.blocks.delete(index);
    if (block === undefined) return;
    if (block.kind === 'text') {
      const rest = block.redactor.flush();
      if (rest !== '' && stream.messageId !== null && !completeMessages.has(stream.messageId)) {
        opts.sink({ kind: 'assistant_delta', messageId: stream.messageId, text: rest });
      }
      return;
    }
    if (block.kind !== 'tool') return;
    for (const field of block.fields.values()) {
      if (!('path' in field)) append(block, field.hunk, field.field, field.redactor.flush());
    }
    if (previews[block.toolUseId] !== undefined) {
      send({ kind: 'edit_preview_end', toolUseId: block.toolUseId, reason: 'complete' });
    }
  }

  return {
    onSdkMessage(message) {
      if (isRecord(message) && message['type'] === 'assistant' && isRecord(message['message'])) {
        const id = message['message']['id'];
        if (typeof id === 'string') {
          completeMessages.add(id);
          if (completeMessages.size > 200) completeMessages.delete(completeMessages.values().next().value as string);
        }
        return;
      }
      if (!isRecord(message) || message['type'] !== 'stream_event' || !isRecord(message['event'])) return;
      const parent = typeof message['parent_tool_use_id'] === 'string' ? message['parent_tool_use_id'] : '';
      const event = message['event'];
      let stream = streams.get(parent);
      if (stream === undefined) {
        stream = { messageId: null, blocks: new Map() };
        streams.set(parent, stream);
      }
      const index = typeof event['index'] === 'number' ? event['index'] : -1;

      switch (event['type']) {
        case 'message_start': {
          const msg = event['message'];
          stream.messageId = isRecord(msg) && typeof msg['id'] === 'string' ? msg['id'] : null;
          stream.blocks.clear();
          return;
        }
        case 'content_block_start': {
          const cb = event['content_block'];
          if (!isRecord(cb)) return;
          if (cb['type'] === 'text') {
            stream.blocks.set(index, { kind: 'text', redactor: new StreamRedactor() });
          } else if (cb['type'] === 'tool_use' && typeof cb['id'] === 'string' && PREVIEW_TOOLS.has(String(cb['name']))) {
            const toolName = cb['name'] as PreviewTool;
            const block: ToolBlock = { kind: 'tool', toolUseId: cb['id'], scanner: new PartialJsonScanner(), fields: new Map(), bytes: 0 };
            stream.blocks.set(index, block);
            send({
              kind: 'edit_preview',
              preview: {
                toolUseId: cb['id'],
                agentId: opts.agentId,
                toolName,
                path: null,
                mode: toolName === 'Write' ? 'write' : 'replace',
                hunks: [],
                replaceAll: false,
                streaming: true,
                truncated: false,
                ...(parent === '' ? {} : { parentToolUseId: parent }),
              },
            });
          } else {
            stream.blocks.set(index, { kind: 'ignored' });
          }
          return;
        }
        case 'content_block_delta': {
          const block = stream.blocks.get(index);
          const delta = event['delta'];
          if (block === undefined || !isRecord(delta)) return;
          if (block.kind === 'text' && delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
            const released = block.redactor.push(delta['text']);
            if (released !== '' && stream.messageId !== null) {
              opts.sink({ kind: 'assistant_delta', messageId: stream.messageId, text: released });
            }
          } else if (block.kind === 'tool' && delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
            onToolJson(block, delta['partial_json']);
          }
          return;
        }
        case 'content_block_stop':
          endBlock(stream, index);
          return;
        default:
          return;
      }
    },

    abandonAll() {
      for (const toolUseId of Object.keys(previews)) {
        send({ kind: 'edit_preview_end', toolUseId, reason: 'abandoned' });
      }
      streams.clear();
    },

    inFlight() {
      return Object.values(previews);
    },
  };
}
