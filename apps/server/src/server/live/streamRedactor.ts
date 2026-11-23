/**
 * Phase 21 — redaction for text that streams to clients a few characters at a
 * time (an agent's edit being typed, or its chat reply).
 *
 * The log scrubs secrets at its write boundary (`log/redact.ts`), but streamed
 * text never passes that boundary, and scrubbing each tiny chunk on its own would
 * miss a key cut in two — the first half would already be on everyone's screen.
 *
 * Every pattern `redactString` knows (sk-ant keys, GitHub tokens, credentials in
 * a URL) is a run of NON-whitespace. So text is released only up to the last
 * whitespace character seen, scrubbed as it goes; whatever follows is held until
 * more arrives or the field ends. A secret is therefore always scrubbed whole,
 * and released text concatenates to exactly `redactString(full)`.
 *
 * The cost is that typing is released a word at a time, which the client's
 * typing animation smooths over anyway.
 */
import { redactString } from '../../log/redact.js';

const WHITESPACE = /\s/;

export class StreamRedactor {
  #held = '';

  /** Add text; returns whatever can now be released, already scrubbed. */
  push(text: string): string {
    this.#held += text;
    let cut = -1;
    for (let i = this.#held.length - 1; i >= 0; i--) {
      if (WHITESPACE.test(this.#held[i] as string)) {
        cut = i;
        break;
      }
    }
    if (cut < 0) return '';
    const release = this.#held.slice(0, cut + 1);
    this.#held = this.#held.slice(cut + 1);
    return redactString(release);
  }

  /** The field ended: release everything left, scrubbed. */
  flush(): string {
    const release = this.#held;
    this.#held = '';
    return release === '' ? '' : redactString(release);
  }
}
