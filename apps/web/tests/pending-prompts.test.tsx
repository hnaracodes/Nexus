import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PendingPrompts, derivePending } from '../src/components/PendingPrompts.js';
import type { NexusEvent } from '@nexus/protocol/events';

function log(...partials: Record<string, unknown>[]): NexusEvent[] {
  return partials.map(
    (p, i) => ({ seq: i + 1, ts: '2026-07-30T00:00:00.000Z', roomId: 'room_a', ...p }) as NexusEvent,
  );
}

const prompt = (displayName: string, text: string, wasDriver?: boolean) => ({
  type: 'user_prompt',
  participantId: `p_${displayName}`,
  displayName,
  text,
  ...(wasDriver === undefined ? {} : { wasDriver }),
});

describe('derivePending', () => {
  it('treats a prompt as queued until a batch event names its seq', () => {
    const pending = derivePending(log(prompt('Ada', 'first'), prompt('Bob', 'second')));
    expect(pending.map((p) => p.text)).toEqual(['first', 'second']);
  });

  it('retires prompts that were delivered', () => {
    const pending = derivePending(
      log(
        prompt('Ada', 'first'),
        { type: 'prompt_batch_delivered', promptSeqs: [1], driverId: 'p_Ada' },
        prompt('Bob', 'second'),
      ),
    );
    expect(pending.map((p) => p.text)).toEqual(['second']);
  });

  it('keeps discarded prompts visible rather than dropping them silently', () => {
    const pending = derivePending(
      log(prompt('Bob', 'queued'), {
        type: 'prompt_batch_discarded',
        promptSeqs: [1],
        byParticipantId: 'p_Ada',
        byDisplayName: 'Ada',
      }),
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe('discarded');
  });

  it('reports an absent wasDriver as unknown, not as false', () => {
    // The backward-compatibility case: a JSONL log written before phase 4.
    const [old] = derivePending(log(prompt('Ada', 'legacy')));
    expect(old?.wasDriver).toBeNull();

    const [fresh] = derivePending(log(prompt('Bob', 'modern', false)));
    expect(fresh?.wasDriver).toBe(false);
  });

  it('orders by seq regardless of the order events were folded in', () => {
    const events = log(prompt('Ada', 'a'), prompt('Bob', 'b'), prompt('Cara', 'c'));
    expect(derivePending([...events].reverse()).map((p) => p.text)).toEqual(['a', 'b', 'c']);
  });
});

describe('PendingPrompts', () => {
  it('renders nothing when the queue is empty', () => {
    const { container } = render(
      <PendingPrompts
        events={log({ type: 'room_created', cwd: '/tmp', repoUrl: null })}
        onResend={() => undefined}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the author and text of a queued prompt', () => {
    render(<PendingPrompts events={log(prompt('Bob', 'also update the README'))} onResend={() => undefined} />);
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('also update the README')).toBeInTheDocument();
  });

  it('marks the driver among queued prompts', () => {
    render(<PendingPrompts events={log(prompt('Ada', 'do X', true))} onResend={() => undefined} />);
    expect(screen.getByText('driver')).toBeInTheDocument();
  });

  it('offers a resend for a discarded prompt and sends the original text', () => {
    const onResend = vi.fn();
    render(
      <PendingPrompts
        events={log(prompt('Bob', 'lost to a stop'), {
          type: 'prompt_batch_discarded',
          promptSeqs: [1],
          byParticipantId: 'p_Ada',
          byDisplayName: 'Ada',
        })}
        onResend={onResend}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /resend/i }));
    expect(onResend).toHaveBeenCalledWith('lost to a stop');
  });

  it('offers no resend for a prompt that is merely queued', () => {
    render(<PendingPrompts events={log(prompt('Bob', 'still waiting'))} onResend={() => undefined} />);
    expect(screen.queryByRole('button', { name: /resend/i })).toBeNull();
  });
});
