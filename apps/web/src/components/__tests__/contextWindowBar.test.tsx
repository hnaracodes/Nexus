import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { NexusEvent } from '@syncode/protocol/events';
import { ContextWindowBar } from '../ContextWindowBar.js';

function usage(overrides: Partial<Extract<NexusEvent, { type: 'context_usage' }>> = {}): NexusEvent {
  return {
    type: 'context_usage',
    seq: 1,
    ts: '2026-01-01T00:00:00.000Z',
    roomId: 'room_1',
    model: 'claude-sonnet-5',
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    contextWindow: 10000,
    compactedFromTokens: null,
    ...overrides,
  };
}

describe('ContextWindowBar', () => {
  it('renders "usage unavailable" — never 0% — before any context_usage event has arrived', () => {
    render(<ContextWindowBar events={[]} />);
    expect(screen.getByText('Usage unavailable')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('renders the ratio from a context_usage event', () => {
    render(
      <ContextWindowBar
        events={[usage({ inputTokens: 2000, cacheReadInputTokens: 500, cacheCreationInputTokens: 500, contextWindow: 10000 })]}
      />,
    );
    // (2000 + 500 + 500) / 10000 = 30%
    expect(screen.getByText('30%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30');
  });

  it('uses the LAST context_usage event, not the first', () => {
    render(
      <ContextWindowBar
        events={[
          usage({ seq: 1, inputTokens: 1000, contextWindow: 10000 }),
          usage({ seq: 2, inputTokens: 9000, contextWindow: 10000 }),
        ]}
      />,
    );
    expect(screen.getByText('90%')).toBeInTheDocument();
  });

  it('renders a compaction marker when compactedFromTokens is set', () => {
    render(<ContextWindowBar events={[usage({ compactedFromTokens: 42000 })]} />);
    expect(screen.getByText('Compacted')).toBeInTheDocument();
  });

  it('renders no compaction marker on an ordinary usage event', () => {
    render(<ContextWindowBar events={[usage({ compactedFromTokens: null })]} />);
    expect(screen.queryByText('Compacted')).not.toBeInTheDocument();
  });

  it('ignores non-context_usage events entirely', () => {
    const other: NexusEvent = {
      type: 'agent_idle',
      seq: 1,
      ts: '2026-01-01T00:00:00.000Z',
      roomId: 'room_1',
    };
    render(<ContextWindowBar events={[other]} />);
    expect(screen.getByText('Usage unavailable')).toBeInTheDocument();
  });
});
