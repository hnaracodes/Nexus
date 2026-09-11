import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Panel } from '../Panel.js';
import { LAYOUT } from '../../design/tokens.js';

describe('Panel', () => {
  it('shows its content when open', () => {
    render(
      <Panel open onToggleOpen={vi.fn()} height={300} onHeightChange={vi.fn()} agentStatus={{ state: 'idle' }} now={0}>
        <p>Transcript content</p>
      </Panel>,
    );
    expect(screen.getByText('Transcript content')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /collapse panel/i })).toBeInTheDocument();
  });

  it('hides its content when collapsed, but keeps the header reachable', () => {
    render(
      <Panel open={false} onToggleOpen={vi.fn()} height={300} onHeightChange={vi.fn()} agentStatus={{ state: 'idle' }} now={0}>
        <p>Transcript content</p>
      </Panel>,
    );
    expect(screen.queryByText('Transcript content')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /expand panel/i })).toBeInTheDocument();
  });

  it('reports a toggle click to the caller', () => {
    const onToggleOpen = vi.fn();
    render(
      <Panel open onToggleOpen={onToggleOpen} height={300} onHeightChange={vi.fn()} agentStatus={{ state: 'idle' }} now={0}>
        <p>x</p>
      </Panel>,
    );
    fireEvent.click(screen.getByRole('button', { name: /collapse panel/i }));
    expect(onToggleOpen).toHaveBeenCalled();
  });

  it('grows when the drag handle is dragged upward, clamped to the max', () => {
    const onHeightChange = vi.fn();
    render(
      <Panel open onToggleOpen={vi.fn()} height={300} onHeightChange={onHeightChange} agentStatus={{ state: 'idle' }} now={0}>
        <p>x</p>
      </Panel>,
    );
    const handle = screen.getByRole('separator', { name: /resize panel/i });
    fireEvent.mouseDown(handle, { clientY: 500 });
    fireEvent.mouseMove(window, { clientY: 400 }); // dragged up 100px
    expect(onHeightChange).toHaveBeenCalledWith(400);

    fireEvent.mouseMove(window, { clientY: -10_000 }); // absurd drag, must clamp
    expect(onHeightChange).toHaveBeenLastCalledWith(LAYOUT.panelMaxHeight);

    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientY: 0 });
    // No further calls once the drag has ended.
    expect(onHeightChange).toHaveBeenCalledTimes(2);
  });

  it('shrinks toward the minimum when dragged downward past it', () => {
    const onHeightChange = vi.fn();
    render(
      <Panel open onToggleOpen={vi.fn()} height={150} onHeightChange={onHeightChange} agentStatus={{ state: 'idle' }} now={0}>
        <p>x</p>
      </Panel>,
    );
    const handle = screen.getByRole('separator', { name: /resize panel/i });
    fireEvent.mouseDown(handle, { clientY: 0 });
    fireEvent.mouseMove(window, { clientY: 10_000 });
    expect(onHeightChange).toHaveBeenCalledWith(LAYOUT.panelMinHeight);
  });
});
