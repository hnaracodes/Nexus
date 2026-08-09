import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneErrorBoundary } from '../PaneErrorBoundary.js';

function Boom(): JSX.Element {
  throw new Error('workspace exploded');
}

describe('PaneErrorBoundary', () => {
  beforeEach(() => {
    // React logs the caught error to console.error by design. Silence it so a
    // deliberately-thrown test error doesn't read as a failing suite.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders its fallback instead of unmounting when a child throws', () => {
    render(
      <PaneErrorBoundary label="Workspace">
        <Boom />
      </PaneErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/workspace/i);
  });

  it('keeps siblings outside the boundary mounted — the blank-screen guarantee', () => {
    render(
      <div>
        <p>approval controls</p>
        <PaneErrorBoundary label="Workspace">
          <Boom />
        </PaneErrorBoundary>
      </div>,
    );
    expect(screen.getByText('approval controls')).toBeInTheDocument();
  });

  it('renders children untouched when nothing throws', () => {
    render(
      <PaneErrorBoundary label="Workspace">
        <p>file tree</p>
      </PaneErrorBoundary>,
    );
    expect(screen.getByText('file tree')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('never puts the thrown error message on screen, since it can quote room content', () => {
    render(
      <PaneErrorBoundary label="Workspace">
        <Boom />
      </PaneErrorBoundary>,
    );
    expect(screen.queryByText(/workspace exploded/)).toBeNull();
  });
});
