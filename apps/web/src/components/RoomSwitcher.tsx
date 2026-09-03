import { useEffect, useRef, useState } from 'react';
import { Command, Trash2 } from 'lucide-react';
import type { RecentRoom } from '../rooms.js';
import { ShortcutHint } from './ShortcutHint.js';

function formatRelativeTime(lastSeenAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - lastSeenAt) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function matchesQuery(room: RecentRoom, query: string): boolean {
  if (query === '') return true;
  const haystack = `${room.label} ${room.displayName} ${room.roomId}`.toLowerCase();
  return haystack.includes(query);
}

/**
 * The `⌘K` command palette: recent rooms, a "New room" entry, and — because
 * this file persists room access tokens in `localStorage` — a permanent
 * disclosure of that fact plus one-click ways to undo it.
 */
export function RoomSwitcher({
  open,
  onClose,
  rooms,
  currentRoomId,
  onNavigate,
  onForget,
  onForgetAll,
}: {
  open: boolean;
  onClose: () => void;
  rooms: RecentRoom[];
  currentRoomId: string | null;
  onNavigate: (room: RecentRoom) => void;
  onForget: (roomId: string) => void;
  onForgetAll: () => void;
}): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const filtered = rooms.filter(
    (room) => room.roomId !== currentRoomId && matchesQuery(room, query.trim().toLowerCase()),
  );
  const totalItems = filtered.length + 1; // + "New room"

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    setQuery('');
    setHighlighted(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (open) return;
    previouslyFocused.current?.focus();
  }, [open]);

  useEffect(() => {
    setHighlighted((current) => Math.min(current, Math.max(totalItems - 1, 0)));
  }, [totalItems]);

  if (!open) return null;

  function focusableElements(): HTMLElement[] {
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, [tabindex]:not([tabindex="-1"])',
    );
    return nodes ? Array.from(nodes) : [];
  }

  function handleKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'Tab') {
      const list = focusableElements();
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((current) => (current + 1) % totalItems);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((current) => (current - 1 + totalItems) % totalItems);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (highlighted < filtered.length) {
        const room = filtered[highlighted];
        if (room) {
          onNavigate(room);
          onClose();
        }
      } else {
        window.location.assign('/new');
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-bg/70 pt-24"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Switch room"
        onKeyDown={handleKeyDown}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-border bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Command size={16} className="shrink-0 text-fg-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlighted(0);
            }}
            placeholder="Switch room…"
            aria-label="Filter rooms"
            className="min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-muted focus:outline-none"
          />
        </div>

        <ul role="listbox" aria-label="Recent rooms" className="max-h-80 overflow-auto py-2">
          {filtered.length === 0 && query.trim() !== '' && (
            <li className="px-4 py-2 text-sm text-fg-muted">No matching rooms</li>
          )}
          {filtered.map((room, index) => (
            <li key={room.roomId} className="flex items-center gap-1 px-2">
              <button
                type="button"
                role="option"
                aria-selected={highlighted === index}
                onClick={() => {
                  onNavigate(room);
                  onClose();
                }}
                onMouseEnter={() => setHighlighted(index)}
                className={`flex min-h-11 flex-1 items-center gap-2 rounded px-2 py-2 text-left text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  highlighted === index ? 'bg-surface-2' : ''
                }`}
              >
                <span className="flex-1 truncate">{room.label}</span>
                <span className="shrink-0 text-xs text-fg-muted">
                  {formatRelativeTime(room.lastSeenAt, Date.now())}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Forget ${room.label}`}
                title={`Forget ${room.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onForget(room.roomId);
                }}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-fg-muted hover:text-danger focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </li>
          ))}

          <li className="px-2">
            <a
              href="/new"
              role="option"
              aria-selected={highlighted === filtered.length}
              onMouseEnter={() => setHighlighted(filtered.length)}
              className={`flex min-h-11 items-center gap-2 rounded px-2 py-2 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                highlighted === filtered.length ? 'bg-surface-2' : ''
              }`}
            >
              <span className="flex-1">New room</span>
              <ShortcutHint combo="mod+shift+n" />
            </a>
          </li>
        </ul>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2 text-xs text-fg-muted">
          <span>Stored on this device only. Anyone using this browser can open these rooms.</span>
          {rooms.length > 0 && (
            <button
              type="button"
              onClick={onForgetAll}
              className="shrink-0 rounded px-2 py-1 font-medium text-danger hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              Forget all
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
