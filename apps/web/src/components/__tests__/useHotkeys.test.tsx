import { useRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useHotkeys } from '../../hooks/useHotkeys.js';
import type { Hotkey } from '../../hooks/useHotkeys.js';

function Harness({ hotkeys }: { hotkeys: Hotkey[] }): JSX.Element {
  useHotkeys(hotkeys);
  return (
    <div>
      <input aria-label="prompt" />
    </div>
  );
}

describe('useHotkeys', () => {
  it('fires a registered mod+k combo on Ctrl+K', () => {
    const handler = vi.fn();
    render(<Harness hotkeys={[{ combo: 'mod+k', handler, description: 'Switch room' }]} />);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not fire a bare-letter hotkey while a text input has focus', () => {
    const handler = vi.fn();
    render(<Harness hotkeys={[{ combo: 'd', handler, description: 'Deny' }]} />);
    const input = screen.getByLabelText('prompt');
    input.focus();
    fireEvent.keyDown(input, { key: 'd' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('fires with allowInInput even while a text input has focus', () => {
    const handler = vi.fn();
    render(
      <Harness
        hotkeys={[{ combo: 'mod+enter', handler, allowInInput: true, description: 'Send' }]}
      />,
    );
    const input = screen.getByLabelText('prompt');
    input.focus();
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('unregisters its listener on unmount', () => {
    const handler = vi.fn();
    const { unmount } = render(
      <Harness hotkeys={[{ combo: 'mod+k', handler, description: 'Switch room' }]} />,
    );
    unmount();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not fire for an unrelated key', () => {
    const handler = vi.fn();
    render(<Harness hotkeys={[{ combo: 'mod+k', handler, description: 'Switch room' }]} />);
    fireEvent.keyDown(document, { key: 'z', ctrlKey: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('only calls preventDefault when a combo actually matches', () => {
    const handler = vi.fn();
    render(<Harness hotkeys={[{ combo: 'mod+k', handler, description: 'Switch room' }]} />);
    const unrelated = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true });
    document.dispatchEvent(unrelated);
    expect(unrelated.defaultPrevented).toBe(false);

    const matching = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true });
    document.dispatchEvent(matching);
    expect(matching.defaultPrevented).toBe(true);
  });

  it('scopes a hotkey to a single element so it never fires globally', () => {
    const handler = vi.fn();

    function Scoped(): JSX.Element {
      const cardRef = useRef<HTMLDivElement>(null);
      useHotkeys([{ combo: 'd', handler, description: 'Deny' }], cardRef);
      return (
        <div>
          <div ref={cardRef} tabIndex={-1} data-testid="card">
            <button type="button">focused control</button>
          </div>
          <button type="button" data-testid="outside">
            outside
          </button>
        </div>
      );
    }

    render(<Scoped />);

    // Pressed on the page body / an unrelated control: must NOT deny.
    fireEvent.keyDown(screen.getByTestId('outside'), { key: 'd' });
    expect(handler).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'd' });
    expect(handler).not.toHaveBeenCalled();

    // Pressed while the card (or something inside it) has focus: fires.
    fireEvent.keyDown(screen.getByTestId('card'), { key: 'd' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
