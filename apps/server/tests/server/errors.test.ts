import { describe, expect, it } from 'vitest';
import { toUserMessage } from '../../src/server/errors.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

describe('toUserMessage', () => {
  it('explains an authentication failure and what to do', () => {
    const message = toUserMessage(new Error('401 Unauthorized from api.anthropic.com'));
    expect(message).toMatch(/api key/i);
    expect(message).not.toContain('401 Unauthorized from');
  });

  it('explains a rate limit', () => {
    expect(toUserMessage(new Error('429 Too Many Requests'))).toMatch(/rate limit|slow down/i);
  });

  it('explains a connection failure without the errno', () => {
    const message = toUserMessage(new Error('connect ECONNREFUSED 127.0.0.1:443'));
    expect(message).toMatch(/could not reach|connection/i);
    expect(message).not.toContain('ECONNREFUSED');
  });

  it('scrubs a key from an unrecognized error (I4)', () => {
    const message = toUserMessage(new Error(`weird failure using ${KEY}`));
    expect(message).not.toContain('sk-ant');
    expect(message).not.toContain(KEY);
  });

  it('never returns an empty string', () => {
    expect(toUserMessage(undefined).length).toBeGreaterThan(0);
    expect(toUserMessage(null).length).toBeGreaterThan(0);
  });

  it('never returns a stack trace', () => {
    expect(toUserMessage(new Error('boom'))).not.toContain('    at ');
  });
});
