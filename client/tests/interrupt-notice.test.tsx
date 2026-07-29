import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InterruptNotice } from '../src/components/InterruptNotice.js';
import type { NexusEvent } from '../../src/protocol/events.js';

function log(...partials: Record<string, unknown>[]): NexusEvent[] {
  return partials.map(
    (p, i) => ({ seq: i + 1, ts: '2026-07-28T00:00:00.000Z', roomId: 'room_a', ...p }) as NexusEvent,
  );
}

describe('InterruptNotice', () => {
  it('renders nothing when nobody has interrupted', () => {
    const { container } = render(
      <InterruptNotice events={log({ type: 'room_created', cwd: '/tmp', repoUrl: null })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('names the participant who stopped the agent', () => {
    render(
      <InterruptNotice
        events={log({ type: 'interrupted', participantId: 'p_grace', displayName: 'Grace' })}
      />,
    );
    expect(screen.getByText(/Grace stopped the agent/i)).toBeInTheDocument();
  });

  it('shows only the most recent interrupt when several happened', () => {
    render(
      <InterruptNotice
        events={log(
          { type: 'interrupted', participantId: 'p_ada', displayName: 'Ada' },
          { type: 'interrupted', participantId: 'p_grace', displayName: 'Grace' },
        )}
      />,
    );
    expect(screen.getByText(/Grace stopped the agent/i)).toBeInTheDocument();
    expect(screen.queryByText(/Ada stopped the agent/i)).toBeNull();
  });
});
