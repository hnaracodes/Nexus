import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PendingPrompts } from '../PendingPrompts.js';
import { delivered, discarded, prompt } from './bannersFixtures.js';

describe('PendingPrompts queued rows', () => {
  const events = [prompt(1, 'p_me', 'Me', 'mine'), prompt(2, 'p_bob', 'Bob', 'theirs')];

  it('explains when queued prompts go out', () => {
    render(<PendingPrompts events={events} onResend={() => {}} />);
    expect(
      screen.getAllByText(/Queued — goes to the agent when it finishes this turn/),
    ).toHaveLength(2);
  });

  it('offers Stop & send now for own prompts only', () => {
    const onSendNow = vi.fn();
    render(
      <PendingPrompts events={events} onResend={() => {}} selfId="p_me" onSendNow={onSendNow} />,
    );
    const buttons = screen.getAllByRole('button', { name: /Stop & send now/ });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(onSendNow).toHaveBeenCalledWith(['mine']);
  });

  it('offers nothing when selfId is unknown, even with onSendNow', () => {
    render(<PendingPrompts events={events} onResend={() => {}} onSendNow={() => {}} />);
    expect(screen.queryByRole('button', { name: /Stop & send now/ })).toBeNull();
  });

  it('Stop & send now retires the original row so the text never shows twice', () => {
    const onSendNow = vi.fn();
    const { rerender } = render(
      <PendingPrompts events={events} onResend={() => {}} selfId="p_me" onSendNow={onSendNow} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Stop & send now/ }));
    // The server then logs the stop's discard of the original seq: it must not
    // come back as a red "dropped" row offering a third copy.
    rerender(
      <PendingPrompts
        events={[...events, discarded(3, [1, 2], 'Me')]}
        onResend={() => {}}
        selfId="p_me"
        onSendNow={onSendNow}
      />,
    );
    expect(screen.queryByText('mine')).toBeNull();
    expect(screen.getByText('theirs')).toBeTruthy();
  });

  it('offers nothing without onSendNow', () => {
    render(<PendingPrompts events={events} onResend={() => {}} selfId="p_me" />);
    expect(screen.queryByRole('button', { name: /Stop & send now/ })).toBeNull();
  });

  it('delivered prompts vanish', () => {
    render(<PendingPrompts events={[...events, delivered(3, [1, 2])]} onResend={() => {}} />);
    expect(screen.queryByLabelText('Queued prompts')).toBeNull();
  });
});

describe('PendingPrompts discarded rows', () => {
  it('single dropped prompts: Resend, Edit, Dismiss; dismiss removes only that one', () => {
    const onResend = vi.fn();
    const onEdit = vi.fn();
    const events = [
      prompt(1, 'p_a', 'A', 'one'),
      discarded(2, [1], 'Ada'),
      prompt(3, 'p_b', 'B', 'two'),
      discarded(4, [3], 'Ada'),
    ];
    render(<PendingPrompts events={events} onResend={onResend} onEdit={onEdit} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    fireEvent.click(within(rows[0]!).getByRole('button', { name: /Edit/ }));
    expect(onEdit).toHaveBeenCalledWith('one');
    fireEvent.click(within(rows[1]!).getByRole('button', { name: /Resend/ }));
    expect(onResend).toHaveBeenCalledWith('two');
    // Resend retires the red row (the resend arrives as a fresh prompt).
    expect(screen.queryByText('two')).toBeNull();
    fireEvent.click(within(rows[0]!).getByRole('button', { name: /Dismiss/ }));
    expect(screen.queryByText('one')).toBeNull();
  });

  it('hides Edit when onEdit is not supplied', () => {
    render(
      <PendingPrompts
        events={[prompt(1, 'p', 'A', 'x'), discarded(2, [1], 'Ada')]}
        onResend={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
  });

  it('groups prompts dropped by one stop', () => {
    const onResend = vi.fn();
    const events = [
      prompt(1, 'p', 'A', 'one'),
      prompt(2, 'p', 'A', 'two'),
      discarded(3, [1, 2], 'Ada'),
    ];
    render(<PendingPrompts events={events} onResend={onResend} />);
    expect(screen.getByText(/2 messages were dropped when Ada stopped the agent/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resend all' }));
    expect(onResend).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText('Queued prompts')).toBeNull();
  });

  it('Dismiss all removes the group but keeps other rows', () => {
    const events = [
      prompt(1, 'p', 'A', 'one'),
      prompt(2, 'p', 'A', 'two'),
      discarded(3, [1, 2], 'Ada'),
      prompt(4, 'p', 'A', 'later'),
    ];
    render(<PendingPrompts events={events} onResend={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss all' }));
    expect(screen.queryByText(/messages were dropped/)).toBeNull();
    expect(screen.getByText('later')).toBeTruthy();
  });
});
