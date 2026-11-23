/**
 * Phase 21 — an incremental JSON scanner for a tool call's arguments as the
 * model streams them (`input_json_delta.partial_json`).
 *
 * Feed it chunks of one JSON value; it reports string values as they grow
 * (decoded, by path), and scalars when they complete. Strings are what matter
 * here — `file_path`, `old_string`, `new_string`, `content` — and they arrive a
 * few characters at a time, often with an escape (`\n`, `é`, half of a
 * surrogate pair) cut in two between chunks.
 *
 * Never throws: input that is not JSON sets `failed` and the scanner goes quiet.
 * A preview is a courtesy; the real tool input is parsed by the SDK regardless.
 */

export type JsonPath = (string | number)[];

export type ScanEvent =
  | { type: 'string_start'; path: JsonPath }
  | { type: 'string_append'; path: JsonPath; text: string }
  | { type: 'string_end'; path: JsonPath }
  | { type: 'scalar'; path: JsonPath; value: boolean | number | null };

interface ObjectFrame {
  kind: 'object';
  path: JsonPath;
  expect: 'key_or_end' | 'key' | 'colon' | 'value' | 'comma_or_end';
  key: string;
}
interface ArrayFrame {
  kind: 'array';
  path: JsonPath;
  expect: 'value_or_end' | 'value' | 'comma_or_end';
  index: number;
}
type Frame = ObjectFrame | ArrayFrame;

const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const LITERAL_CHAR = /[-+.0-9a-zA-Z]/;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

export class PartialJsonScanner {
  #failed = false;
  #stack: Frame[] = [];
  #done = false;
  /** Inside a string: whether it is an object key, and the value path otherwise. */
  #string: { role: 'key' | 'value'; path: JsonPath; key: string } | null = null;
  #escape: '' | '\\' | 'u' = '';
  #hex = '';
  /** A high surrogate waiting for its low half, so a pair is never emitted split. */
  #highSurrogate = '';
  #literal = '';
  #literalPath: JsonPath = [];

  get failed(): boolean {
    return this.#failed;
  }

  push(chunk: string): ScanEvent[] {
    if (this.#failed) return [];
    const events: ScanEvent[] = [];
    let pending = '';
    const flushText = (): void => {
      if (pending !== '' && this.#string !== null && this.#string.role === 'value') {
        events.push({ type: 'string_append', path: this.#string.path, text: pending });
      }
      pending = '';
    };
    const emitChar = (text: string): void => {
      if (this.#string === null) return;
      if (this.#string.role === 'key') this.#string.key += text;
      else pending += text;
    };
    const emitCodeUnit = (unit: number): void => {
      const ch = String.fromCharCode(unit);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        // Hold a high surrogate until its partner arrives.
        if (this.#highSurrogate !== '') emitChar(this.#highSurrogate);
        this.#highSurrogate = ch;
        return;
      }
      if (this.#highSurrogate !== '') {
        emitChar(this.#highSurrogate);
        this.#highSurrogate = '';
      }
      emitChar(ch);
    };
    const fail = (): ScanEvent[] => {
      this.#failed = true;
      return [];
    };

    for (const ch of chunk) {
      // --- inside a string ---------------------------------------------------
      if (this.#string !== null) {
        if (this.#escape === 'u') {
          if (!/[0-9a-fA-F]/.test(ch)) return fail();
          this.#hex += ch;
          if (this.#hex.length === 4) {
            emitCodeUnit(Number.parseInt(this.#hex, 16));
            this.#hex = '';
            this.#escape = '';
          }
          continue;
        }
        if (this.#escape === '\\') {
          if (ch === 'u') {
            this.#escape = 'u';
            continue;
          }
          const decoded = ESCAPES[ch];
          if (decoded === undefined) return fail();
          emitCodeUnit(decoded.charCodeAt(0));
          this.#escape = '';
          continue;
        }
        if (ch === '\\') {
          this.#escape = '\\';
          continue;
        }
        if (ch === '"') {
          if (this.#highSurrogate !== '') {
            emitChar(this.#highSurrogate);
            this.#highSurrogate = '';
          }
          flushText();
          const finished = this.#string;
          this.#string = null;
          if (finished.role === 'key') {
            const top = this.#stack[this.#stack.length - 1] as ObjectFrame;
            top.key = finished.key;
            top.expect = 'colon';
          } else {
            events.push({ type: 'string_end', path: finished.path });
            this.#valueDone();
          }
          continue;
        }
        if (this.#highSurrogate !== '') {
          emitChar(this.#highSurrogate);
          this.#highSurrogate = '';
        }
        emitChar(ch);
        continue;
      }

      // --- inside a literal (number / true / false / null) ---------------------
      if (this.#literal !== '') {
        if (LITERAL_CHAR.test(ch)) {
          this.#literal += ch;
          continue;
        }
        if (!this.#finishLiteral(events)) return fail();
        // fall through: this char is a delimiter, handled below
      }

      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
      if (this.#done) return fail();
      const top = this.#stack[this.#stack.length - 1];

      if (top !== undefined && top.kind === 'object' && top.expect !== 'value') {
        if (ch === '"' && (top.expect === 'key' || top.expect === 'key_or_end')) {
          this.#string = { role: 'key', path: [], key: '' };
          continue;
        }
        if (ch === ':' && top.expect === 'colon') {
          top.expect = 'value';
          continue;
        }
        if (ch === ',' && top.expect === 'comma_or_end') {
          top.expect = 'key';
          continue;
        }
        if (ch === '}' && (top.expect === 'comma_or_end' || top.expect === 'key_or_end')) {
          this.#stack.pop();
          this.#valueDone();
          continue;
        }
        return fail();
      }
      if (top !== undefined && top.kind === 'array' && top.expect === 'comma_or_end') {
        if (ch === ',') {
          top.index += 1;
          top.expect = 'value';
          continue;
        }
        if (ch === ']') {
          this.#stack.pop();
          this.#valueDone();
          continue;
        }
        return fail();
      }
      if (top !== undefined && top.kind === 'array' && top.expect === 'value_or_end' && ch === ']') {
        this.#stack.pop();
        this.#valueDone();
        continue;
      }

      // --- a value is expected here --------------------------------------------
      const path = this.#valuePath();
      if (ch === '{') {
        this.#stack.push({ kind: 'object', path, expect: 'key_or_end', key: '' });
      } else if (ch === '[') {
        this.#stack.push({ kind: 'array', path, expect: 'value_or_end', index: 0 });
      } else if (ch === '"') {
        this.#string = { role: 'value', path, key: '' };
        events.push({ type: 'string_start', path });
      } else if (LITERAL_CHAR.test(ch)) {
        this.#literal = ch;
        this.#literalPath = path;
      } else {
        return fail();
      }
    }
    flushText();
    return events;
  }

  #valuePath(): JsonPath {
    const top = this.#stack[this.#stack.length - 1];
    if (top === undefined) return [];
    return top.kind === 'object' ? [...top.path, top.key] : [...top.path, top.index];
  }

  #valueDone(): void {
    const top = this.#stack[this.#stack.length - 1];
    if (top === undefined) this.#done = true;
    else top.expect = 'comma_or_end';
  }

  #finishLiteral(events: ScanEvent[]): boolean {
    const text = this.#literal;
    this.#literal = '';
    let value: boolean | number | null;
    if (text === 'true') value = true;
    else if (text === 'false') value = false;
    else if (text === 'null') value = null;
    else if (NUMBER.test(text)) value = Number(text);
    else return false;
    events.push({ type: 'scalar', path: this.#literalPath, value });
    this.#valueDone();
    return true;
  }
}
