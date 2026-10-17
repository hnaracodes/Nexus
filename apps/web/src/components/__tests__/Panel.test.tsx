import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Panel } from '../Panel.js';
import { PANEL } from '../../layout/dimensions.js';

function renderPanel(props: Partial<React.ComponentProps<typeof Panel>> = {}) {
  return render(
    <Panel
      open
      onToggleOpen={vi.fn()}
      height={300}
      onHeightChange={vi.fn()}
      activeTab="output"
      onTabChange={vi.fn()}
      {...props}
    >
      <p>Panel content</p>
    </Panel>,
  );
}

describe('Panel', () => {
  it('shows its content when open', () => {
    renderPanel();
    expect(screen.getByText('Panel content')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /collapse panel/i })).toBeInTheDocument();
  });

  it('hides its content when collapsed, but keeps the header reachable', () => {
    renderPanel({ open: false });
    expect(screen.queryByText('Panel content')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /expand panel/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Output' })).toBeInTheDocument();
  });

  it('reports a toggle click to the caller', () => {
    const onToggleOpen = vi.fn();
    renderPanel({ onToggleOpen });
    fireEvent.click(screen.getByRole('button', { name: /collapse panel/i }));
    expect(onToggleOpen).toHaveBeenCalled();
  });

  it('offers OUTPUT and DIFF tabs, marks the active one, and reports a switch', () => {
    const onTabChange = vi.fn();
    renderPanel({ activeTab: 'output', onTabChange });
    expect(screen.getByRole('tab', { name: 'Output' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));
    expect(onTabChange).toHaveBeenCalledWith('diff');
  });

  it('grows when the drag handle is dragged upward, clamped to the max', () => {
    const onHeightChange = vi.fn();
    renderPanel({ onHeightChange });
    const handle = screen.getByRole('separator', { name: /resize panel/i });
    fireEvent.mouseDown(handle, { clientY: 500 });
    fireEvent.mouseMove(window, { clientY: 400 }); // dragged up 100px
    expect(onHeightChange).toHaveBeenCalledWith(400);

    fireEvent.mouseMove(window, { clientY: -10_000 }); // absurd drag, must clamp
    expect(onHeightChange).toHaveBeenLastCalledWith(PANEL.max);

    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientY: 0 });
    expect(onHeightChange).toHaveBeenCalledTimes(2);
  });

  it('shrinks toward the minimum when dragged downward past it', () => {
    const onHeightChange = vi.fn();
    renderPanel({ height: 150, onHeightChange });
    const handle = screen.getByRole('separator', { name: /resize panel/i });
    fireEvent.mouseDown(handle, { clientY: 0 });
    fireEvent.mouseMove(window, { clientY: 10_000 });
    expect(onHeightChange).toHaveBeenCalledWith(PANEL.min);
  });
});
