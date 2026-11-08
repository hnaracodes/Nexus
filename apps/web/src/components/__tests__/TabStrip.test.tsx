import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AGENTS_TAB_ID, TabStrip, isTabDirty } from '../TabStrip.js';
import type { OpenTab } from '../TabStrip.js';

const file = (id: string, dirty = false): OpenTab => ({ id, kind: 'file', dirty });

describe('TabStrip', () => {
  it('renders one tab per open file, showing the basename', () => {
    render(
      <TabStrip
        tabs={[file('src/App.tsx'), file('README.md')]}
        activeId="src/App.tsx"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('tab', { name: /App\.tsx/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /README\.md/ })).toBeInTheDocument();
  });

  it('marks the active tab selected', () => {
    render(<TabStrip tabs={[file('a.ts'), file('b.ts')]} activeId="b.ts" onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('tab', { name: /a\.ts/ })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: /b\.ts/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('reports a click as a select', () => {
    const onSelect = vi.fn();
    render(<TabStrip tabs={[file('a.ts')]} activeId={null} onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /a\.ts/ }));
    expect(onSelect).toHaveBeenCalledWith('a.ts');
  });

  it('closes the clicked tab without also selecting it', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<TabStrip tabs={[file('a.ts')]} activeId="a.ts" onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close a\.ts/i }));
    expect(onClose).toHaveBeenCalledWith('a.ts');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('closes a tab on middle-click (auxclick button 1) and ignores other aux buttons', () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(<TabStrip tabs={[file('a.ts')]} activeId={null} onSelect={onSelect} onClose={onClose} />);
    const tab = screen.getByRole('tab', { name: /a\.ts/ });
    fireEvent(tab, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent(tab, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(onClose).toHaveBeenCalledWith('a.ts');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('prevents the browser autoscroll on a middle mousedown', () => {
    render(<TabStrip tabs={[file('a.ts')]} activeId={null} onSelect={vi.fn()} onClose={vi.fn()} />);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 });
    screen.getByRole('tab', { name: /a\.ts/ }).dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it('shows an unsaved-changes dot on a dirty tab, and still offers the close button', () => {
    render(<TabStrip tabs={[file('a.ts', true)]} activeId="a.ts" onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText(/a\.ts has unsaved changes/i)).toBeInTheDocument();
    // The close button is in the DOM (revealed on hover in place of the dot).
    expect(screen.getByRole('button', { name: /close a\.ts/i })).toBeInTheDocument();
  });

  it('does not show a dirty dot on a clean tab', () => {
    render(<TabStrip tabs={[file('a.ts')]} activeId="a.ts" onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByLabelText(/unsaved changes/i)).toBeNull();
  });

  it('renders the Agents tab as "Agents", selectable and closable like any tab', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <TabStrip
        tabs={[file('a.ts'), { id: AGENTS_TAB_ID, kind: 'agents', dirty: false }]}
        activeId={AGENTS_TAB_ID}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    const agents = screen.getByRole('tab', { name: /agents/i });
    expect(agents).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: /close agents/i }));
    expect(onClose).toHaveBeenCalledWith(AGENTS_TAB_ID);
  });

  it('renders title actions to the right of the tabs', () => {
    render(
      <TabStrip
        tabs={[file('a.md')]}
        activeId="a.md"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        actions={<button type="button">Open Preview</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Open Preview' })).toBeInTheDocument();
  });

  it('shows a placeholder when nothing is open', () => {
    render(<TabStrip tabs={[]} activeId={null} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/no files open/i)).toBeInTheDocument();
  });
});

describe('AGENTS_TAB_ID', () => {
  it('can never equal a workspace-relative path (it contains NUL)', () => {
    expect(AGENTS_TAB_ID).toContain('\u0000');
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

  it('ignores an id that is not open', async () => {
    const { closeTabState } = await import('../../App.js');
    const state = { paths: ['a'], active: 'a' };

    expect(closeTabState(state, 'zzz')).toBe(state);
  });

  it('works on the Agents tab id too, keeping the file tabs', async () => {
    const { closeTabState } = await import('../../App.js');

    expect(closeTabState({ paths: ['a.ts', AGENTS_TAB_ID, 'b.ts'], active: AGENTS_TAB_ID }, AGENTS_TAB_ID)).toEqual({
      paths: ['a.ts', 'b.ts'],
      active: 'b.ts',
    });
  });
});
