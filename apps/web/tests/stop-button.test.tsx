import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StopButton } from '../src/components/StopButton.js';

describe('StopButton', () => {
  it('calls onStop when clicked', () => {
    const onStop = vi.fn();
    render(<StopButton onStop={onStop} busy />);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalled();
  });

  it('stays clickable when the agent looks idle — anyone may stop at any time', () => {
    const onStop = vi.fn();
    render(<StopButton onStop={onStop} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalled();
  });
});
