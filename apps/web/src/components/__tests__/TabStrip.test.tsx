import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TabStrip, isTabDirty } from '../TabStrip.js';

describe('TabStrip', () => {
  it('renders one tab per open file, showing the basename', () => {
    render(
      <TabStrip
        tabs={[
          { path: 'src/App.tsx', dirty: false },
          { path: 'README.md', dirty: false },
        ]}
        activePath="src/App.tsx"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('tab', { name: /App\.tsx/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /README\.md/ })).toBeInTheDocument();
  });

  it('marks the active tab selected', () => {
    render(
      <TabStrip
        tabs={[
          { path: 'a.ts', dirty: false },
          { path: 'b.ts', dirty: false },
        ]}
        activePath="b.ts"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('tab', { name: /a\.ts/ })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: /b\.ts/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('reports a click as a select', () => {
    const onSelect = vi.fn();
    render(
      <TabStrip
        tabs={[{ path: 'a.ts', dirty: false }]}
        activePath={null}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: /a\.ts/ }));
    expect(onSelect).toHaveBeenCalledWith('a.ts');
  });

  it('closes the clicked tab without also selecting it', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <TabStrip
        tabs={[{ path: 'a.ts', dirty: false }]}
        activePath="a.ts"
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /close a\.ts/i }));
    expect(onClose).toHaveBeenCalledWith('a.ts');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows an unsaved-changes marker on a dirty tab', () => {
    render(
      <TabStrip
        tabs={[{ path: 'a.ts', dirty: true }]}
        activePath="a.ts"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/a\.ts has unsaved changes/i)).toBeInTheDocument();
  });

  it('shows a placeholder when nothing is open', () => {
    render(<TabStrip tabs={[]} activePath={null} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/no files open/i)).toBeInTheDocument();
  });
});

describe('isTabDirty', () => {
  it('is false when either side is unknown', () => {
    expect(isTabDirty(null, 'live')).toBe(false);
    expect(isTabDirty('cached', null)).toBe(false);
    expect(isTabDirty(null, null)).toBe(false);
  });

  it('is false when the live text matches the cached snapshot', () => {
    expect(isTabDirty('same', 'same')).toBe(false);
  });

  it('is true when the live text has diverged from the cached snapshot', () => {
    expect(isTabDirty('on disk', 'on disk plus an edit')).toBe(true);
  });
});

/**
 * The rule two tabs cannot distinguish.
 *
 * With `['a','b']` and `b` active, "prefer the left neighbour" and "prefer the
 * right neighbour" both answer `a` — so the two-tab test that shipped with
 * 17a passed under either rule and documented neither. Three tabs, closing the
 * middle one, is the smallest case that tells them apart.
 */
describe('closeTabState — which tab takes focus', () => {
  it('activates the tab to the RIGHT when the closed one had a right neighbour', async () => {
    const { closeTabState } = await import('../../App.js');

    expect(closeTabState({ paths: ['a', 'b', 'c'], active: 'b' }, 'b')).toEqual({
      paths: ['a', 'c'],
      active: 'c',
    });
  });

  it('falls back to the left when the closed tab was the last one', async () => {
    const { closeTabState } = await import('../../App.js');

    expect(closeTabState({ paths: ['a', 'b', 'c'], active: 'c' }, 'c')).toEqual({
      paths: ['a', 'b'],
      active: 'b',
    });
  });

  it('leaves focus alone when a background tab is closed', async () => {
    const { closeTabState } = await import('../../App.js');

    expect(closeTabState({ paths: ['a', 'b', 'c'], active: 'a' }, 'c')).toEqual({
      paths: ['a', 'b'],
      active: 'a',
    });
  });

  it('clears the active tab when the last one closes', async () => {
    const { closeTabState } = await import('../../App.js');

    expect(closeTabState({ paths: ['a'], active: 'a' }, 'a')).toEqual({ paths: [], active: null });
  });

  it('ignores a path that is not open', async () => {
    const { closeTabState } = await import('../../App.js');
    const state = { paths: ['a'], active: 'a' };

    expect(closeTabState(state, 'zzz')).toBe(state);
  });
});
