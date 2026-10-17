import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FolderTree, GitCompare, MessageSquare, Network, Search, ShieldAlert, Users } from 'lucide-react';
import { ActivityBar } from '../ActivityBar.js';
import type { ActivityBarItem } from '../ActivityBar.js';

const ITEMS: ActivityBarItem[] = [
  { id: 'explorer', label: 'Explorer', Icon: FolderTree },
  { id: 'search', label: 'Search', Icon: Search, badge: 3 },
  { id: 'changes', label: 'Source Control', Icon: GitCompare, badge: 0 },
];

describe('ActivityBar', () => {
  it('renders one tab per item and marks the active one selected', () => {
    render(<ActivityBar items={ITEMS} activeView="explorer" onSelect={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'Explorer' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'false');
  });

  it('reports the clicked view to the caller', () => {
    const onSelect = vi.fn();
    render(<ActivityBar items={ITEMS} activeView="explorer" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Source Control' }));
    expect(onSelect).toHaveBeenCalledWith('changes');
  });

  it('shows a badge count when greater than zero, and hides it at zero', () => {
    render(<ActivityBar items={ITEMS} activeView="explorer" onSelect={vi.fn()} />);
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.queryByLabelText(/pending in source control/i)).not.toBeInTheDocument();
  });

  it('marks no tab selected when the region is collapsed (activeView null)', () => {
    render(<ActivityBar items={ITEMS} activeView={null} onSelect={vi.fn()} />);
    for (const tab of screen.getAllByRole('tab')) expect(tab).toHaveAttribute('aria-selected', 'false');
  });
});

describe('ActivityBar — the right (agent) side', () => {
  type AuxView = 'chat' | 'approvals' | 'fleet';
  const AUX: ActivityBarItem<AuxView>[] = [
    { id: 'chat', label: 'Chat', Icon: MessageSquare },
    { id: 'approvals', label: 'Approvals', Icon: ShieldAlert, badge: 2 },
    { id: 'fleet', label: 'Fleet', Icon: Users, badge: 3 },
  ];

  it('switches views, shows the approvals badge, and tags itself as the right bar', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <ActivityBar side="right" items={AUX} activeView="chat" onSelect={onSelect} />,
    );
    expect(container.firstElementChild).toHaveAttribute('data-side', 'right');
    expect(screen.getByLabelText(/2 pending in approvals/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Approvals' }));
    expect(onSelect).toHaveBeenCalledWith('approvals');
  });

  it('keeps the badge on screen when the aux bar is collapsed (activeView null)', () => {
    render(<ActivityBar side="right" items={AUX} activeView={null} onSelect={vi.fn()} />);
    expect(screen.getByLabelText(/2 pending in approvals/i)).toBeInTheDocument();
  });

  it('the Agents button is an action, not a view: aria-pressed, never aria-selected', () => {
    const onClick = vi.fn();
    render(
      <ActivityBar
        side="right"
        items={AUX}
        activeView="chat"
        onSelect={vi.fn()}
        actions={[{ id: 'agents', label: 'Agents', Icon: Network, active: true, onClick }]}
      />,
    );
    const agents = screen.getByRole('button', { name: 'Agents' });
    expect(agents).toHaveAttribute('aria-pressed', 'true');
    expect(agents).not.toHaveAttribute('aria-selected');
    // Chat stays the selected view; the action does not flip any tab.
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'Agents' })).toBeNull();
    fireEvent.click(agents);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
