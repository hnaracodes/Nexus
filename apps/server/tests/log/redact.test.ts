// tests/log/redact.test.ts
import { describe, expect, it } from 'vitest';
import { redactEvent, redactString } from '../../src/log/redact.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

describe('redaction', () => {
  it('replaces an API key in a flat string', () => {
    expect(redactString(`export ANTHROPIC_API_KEY=${KEY}`)).toBe(
      'export ANTHROPIC_API_KEY=[REDACTED]',
    );
  });

  it('replaces an API key nested in tool input', () => {
    const event = {
      seq: 1,
      ts: '2026-07-28T00:00:00.000Z',
      roomId: 'room_a',
      type: 'tool_start',
      toolUseId: 't1',
      toolName: 'Bash',
      input: { command: `curl -H "x-api-key: ${KEY}" https://api.anthropic.com` },
    };
    expect(JSON.stringify(redactEvent(event))).not.toContain('sk-ant');
    expect(JSON.stringify(redactEvent(event))).toContain('[REDACTED]');
  });

  it('replaces a key inside an array element', () => {
    const event = { type: 'tool_start', input: { args: ['--key', KEY] } };
    expect(JSON.stringify(redactEvent(event))).not.toContain('sk-ant');
  });

  it('truncates tool_result output to 4000 characters', () => {
    const event = { type: 'tool_result', output: 'x'.repeat(9000) };
    const redacted = redactEvent(event) as { output: string };
    expect(redacted.output).toHaveLength(4000);
  });

  it('leaves clean events byte-identical', () => {
    const event = { seq: 3, ts: '2026-07-28T00:00:00.000Z', roomId: 'r', type: 'agent_idle' };
    expect(redactEvent(event)).toEqual(event);
  });

  it('does not mutate its argument', () => {
    const event = { type: 'tool_start', input: { command: KEY } };
    redactEvent(event);
    expect(event.input.command).toBe(KEY);
  });
});
