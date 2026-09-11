import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FolderTree, GitCompare, ShieldAlert, Users } from 'lucide-react';
import { ActivityBar } from '../ActivityBar.js';
import type { ActivityBarItem } from '../ActivityBar.js';

const ITEMS: ActivityBarItem[] = [
  { id: 'explorer', label: 'Explorer', Icon: FolderTree },
  { id: 'fleet', label: 'Fleet', Icon: Users, badge: 3 },
  { id: 'approvals', label: 'Approvals', Icon: ShieldAlert, badge: 0 },
  { id: 'changes', label: 'Changes', Icon: GitCompare },
];

describe('ActivityBar', () => {
  it('renders one tab per item and marks the active one selected', () => {
    render(<ActivityBar items={ITEMS} activeView="explorer" onSelect={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'Explorer' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Fleet' })).toHaveAttribute('aria-selected', 'false');
  });

  it('reports the clicked view to the caller', () => {
    const onSelect = vi.fn();
    render(<ActivityBar items={ITEMS} activeView="explorer" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }));
    expect(onSelect).toHaveBeenCalledWith('changes');
  });

  it('shows a badge count when greater than zero, and hides it at zero', () => {
    render(<ActivityBar items={ITEMS} activeView="explorer" onSelect={vi.fn()} />);
    expect(screen.getByText('3')).toBeInTheDocument();
    // Approvals badge is 0 — no "0" badge should render anywhere in the rail.
    expect(screen.queryByLabelText(/pending in approvals/i)).not.toBeInTheDocument();
  });
});
