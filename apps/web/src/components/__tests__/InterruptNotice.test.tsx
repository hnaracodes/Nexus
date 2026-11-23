import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InterruptNotice } from '../InterruptNotice.js';
import { delivered, interrupted } from './bannersFixtures.js';

describe('InterruptNotice', () => {
  it('shows after a stop', () => {
    render(<InterruptNotice events={[interrupted(1, 'Ada')]} />);
    expect(screen.getByRole('status').textContent).toContain('Ada stopped the agent.');
  });

  it('hides once the same agent has a later delivered batch', () => {
    render(<InterruptNotice events={[interrupted(1, 'Ada'), delivered(2, [])]} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('unfocused: a later stop on another agent clearing does not hide an earlier stop', () => {
    // A stopped (no delivery since), then B stopped and B moved on: A is
    // still stopped, so its notice must still show.
    const events = [interrupted(1, 'Ada', 'a1'), interrupted(2, 'Bob', 'a2'), delivered(3, [], 'a2')];
    render(<InterruptNotice events={events} />);
    expect(screen.getByRole('status').textContent).toContain('Ada stopped the agent.');
  });

  it('a delivered batch BEFORE the stop does not clear it', () => {
    render(<InterruptNotice events={[delivered(1, []), interrupted(2, 'Ada')]} />);
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('a different agent batch does not clear it', () => {
    const events = [interrupted(1, 'Ada', 'a1'), delivered(2, [], 'a2')];
    render(<InterruptNotice events={events} focusedAgentId="a1" />);
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('the same agent batch clears it when focused', () => {
    const events = [interrupted(1, 'Ada', 'a1'), delivered(2, [], 'a1')];
    render(<InterruptNotice events={events} focusedAgentId="a1" />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('ignores other agents stops when focused', () => {
    render(<InterruptNotice events={[interrupted(1, 'Ada', 'a2')]} focusedAgentId="a1" />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('dismiss hides it locally; a newer stop shows again', () => {
    const { rerender } = render(<InterruptNotice events={[interrupted(1, 'Ada')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss stop notice' }));
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<InterruptNotice events={[interrupted(1, 'Ada'), interrupted(3, 'Bob')]} />);
    expect(screen.getByRole('status').textContent).toContain('Bob');
  });
});
