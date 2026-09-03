import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBanner } from '../src/components/ErrorBanner.js';

describe('ErrorBanner', () => {
  it('renders nothing when there is no message', () => {
    const { container } = render(<ErrorBanner message={null} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the message and dismisses', () => {
    const onDismiss = vi.fn();
    render(<ErrorBanner message="You are not driving." onDismiss={onDismiss} />);
    expect(screen.getByText('You are not driving.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

/**
 * Reproduces App.tsx's dismiss-by-count wiring: bannerMessage is derived from
 * `errorCount > dismissedCount`, not from comparing message text. A `bump`
 * button simulates a new `error` frame arriving with the SAME text — which is
 * exactly what happens when a non-driver repeatedly tries to prompt and gets
 * "You are not driving" again. Comparing text alone would swallow this repeat
 * after the first dismissal; comparing counts must not.
 */
function DismissByCountHarness({ message }: { message: string }): JSX.Element {
  const [errorCount, setErrorCount] = useState(1);
  const [dismissedCount, setDismissedCount] = useState(0);
  const bannerMessage = errorCount > dismissedCount ? message : null;
  return (
    <div>
      <button type="button" onClick={() => setErrorCount((count) => count + 1)}>
        bump
      </button>
      <ErrorBanner message={bannerMessage} onDismiss={() => setDismissedCount(errorCount)} />
    </div>
  );
}

describe('dismiss-by-count (App.tsx wiring)', () => {
  it('brings the banner back when the same message repeats after a dismissal', () => {
    render(<DismissByCountHarness message="You are not driving." />);

    expect(screen.getByText('You are not driving.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText('You are not driving.')).not.toBeInTheDocument();

    // A repeat of the identical message arrives (errorCount increments).
    fireEvent.click(screen.getByRole('button', { name: /bump/i }));
    expect(screen.getByText('You are not driving.')).toBeInTheDocument();
  });
});
