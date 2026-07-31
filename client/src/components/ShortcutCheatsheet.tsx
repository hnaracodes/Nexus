import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { Hotkey } from '../hooks/useHotkeys.js';
import { ShortcutHint } from './ShortcutHint.js';

/**
 * A modal listing every keyboard shortcut and what it does. Opened with `?`.
 * Focus moves in on open, is trapped inside while open, and returns to
 * whatever triggered it on close. Escape closes this modal and must not
 * reach the interrupt handler — callers register this above the interrupt
 * hotkey's scope, or (as here) stop propagation on Escape themselves.
 */
export function ShortcutCheatsheet({
  open,
  onClose,
  shortcuts,
}: {
  open: boolean;
  onClose: () => void;
  shortcuts: Hotkey[];
}): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const id = window.setTimeout(() => dialogRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (open) return;
    previouslyFocused.current?.focus();
  }, [open]);

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
    if (event.key !== 'Tab') return;
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
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-bg/70 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[80vh] w-full max-w-md overflow-auto rounded-lg border border-border bg-surface p-6 shadow-[0_8px_24px_rgba(0,0,0,0.4)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-fg">Keyboard shortcuts</h2>
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center rounded text-fg-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <ul className="flex flex-col gap-3">
          {shortcuts.map((hotkey) => (
            <li key={hotkey.combo} className="flex items-center justify-between gap-4 text-sm text-fg">
              <span>{hotkey.description}</span>
              <ShortcutHint combo={hotkey.combo} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
