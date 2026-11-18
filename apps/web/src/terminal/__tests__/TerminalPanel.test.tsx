import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// xterm.js draws to a canvas and measures fonts; jsdom has neither. The real
// renderer is checked in a browser — here only the panel's own behaviour.
vi.mock('../XtermView.js', () => ({
  XtermView: ({ termId }: { termId: string }) => <div data-testid="xterm">{termId}</div>,
}));

import { TerminalPanel } from '../TerminalPanel.js';
import { createTerminalHub } from '../terminalHub.js';
import type { RoomView } from '../../store.js';

type Terminals = RoomView['terminals'];
const ON: Terminals = { available: true, enabled: true, canManage: false, list: [] };
const LIST: Terminals['list'] = [
  { termId: 'term_1', title: 'Terminal 1', openedBy: 'Ada', lastTypedBy: 'Bob' },
  { termId: 'term_2', title: 'Terminal 2', openedBy: 'Bob', lastTypedBy: null },
];

function renderPanel(terminals: Terminals) {
  const send = vi.fn();
  render(<TerminalPanel terminals={terminals} hub={createTerminalHub()} send={send} />);
  return send;
}

describe('TerminalPanel (phase 19b)', () => {
  it('with none open, offers to open one', () => {
    const send = renderPanel(ON);
    fireEvent.click(screen.getByRole('button', { name: /new terminal/i }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'term_open' }));
  });

  it('shows a tab per terminal, the first one active, and who typed last', () => {
    renderPanel({ ...ON, list: LIST });
    expect(screen.getByRole('tab', { name: /terminal 1/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /terminal 2/i })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('xterm')).toHaveTextContent('term_1');
    expect(screen.getByText(/last typed by bob/i)).toBeInTheDocument();
  });

  it('switching tabs shows that terminal; closing one asks the server', () => {
    const send = renderPanel({ ...ON, list: LIST });
    fireEvent.click(screen.getByRole('tab', { name: /terminal 2/i }));
    expect(screen.getByTestId('xterm')).toHaveTextContent('term_2');
    fireEvent.click(screen.getByRole('button', { name: /close terminal 2/i }));
    expect(send).toHaveBeenCalledWith({ kind: 'term_close', termId: 'term_2' });
  });

  it('says plainly when the host has switched terminals off', () => {
    renderPanel({ ...ON, enabled: false });
    expect(screen.getByText(/host has switched terminals off/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new terminal/i })).toBeNull();
  });

  it('only the host sees the switch, and it asks for the opposite state', () => {
    renderPanel(ON);
    expect(screen.queryByRole('switch', { name: /allow terminals/i })).toBeNull();

    const send = vi.fn();
    render(<TerminalPanel terminals={{ ...ON, canManage: true }} hub={createTerminalHub()} send={send} />);
    fireEvent.click(screen.getByRole('switch', { name: /allow terminals/i }));
    expect(send).toHaveBeenCalledWith({ kind: 'set_terminal_access', enabled: false });
  });
});
