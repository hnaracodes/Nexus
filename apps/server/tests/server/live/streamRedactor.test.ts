import { describe, expect, it } from 'vitest';
import { redactString } from '../../../src/log/redact.js';
import { StreamRedactor } from '../../../src/server/live/streamRedactor.js';

const SECRETS = [
  'sk-ant-api03-abcdefXYZ0123456789',
  'ghp_ABCDEFghijkl0123456789',
  'github_pat_11ABCDEFG_0123456789abcdef',
];

describe('StreamRedactor', () => {
  for (const secret of SECRETS) {
    it(`never releases any part of ${secret.slice(0, 8)}… across any split`, () => {
      const full = `const key = "${secret}";\nnext line`;
      for (let i = 0; i <= full.length; i++) {
        const r = new StreamRedactor();
        const out = [r.push(full.slice(0, i)), r.push(full.slice(i)), r.flush()];
        // No released piece may contain a recognisable fragment of the secret.
        for (const piece of out) expect(piece.includes(secret.slice(0, 10))).toBe(false);
        expect(out.join('')).toBe(redactString(full));
      }
    });
  }

  it('scrubs credentials in a URL split anywhere', () => {
    const full = 'git remote add origin https://bot:s3cr3t-tok@github.com/o/r.git && echo ok';
    for (let i = 0; i <= full.length; i++) {
      const r = new StreamRedactor();
      const out = [r.push(full.slice(0, i)), r.push(full.slice(i)), r.flush()];
      for (const piece of out) expect(piece.includes('s3cr3t')).toBe(false);
      expect(out.join('')).toBe(redactString(full));
    }
  });

  it('releases ordinary text a word at a time, keeping the unfinished word back', () => {
    const r = new StreamRedactor();
    expect(r.push('hello wor')).toBe('hello ');
    expect(r.push('ld\nnext')).toBe('world\n');
    expect(r.flush()).toBe('next');
    expect(r.flush()).toBe('');
  });
});
