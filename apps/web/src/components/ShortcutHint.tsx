import { isMac } from '../hooks/useHotkeys.js';

const SYMBOLS: Record<string, string> = {
  mod: isMac() ? '⌘' : 'Ctrl',
  shift: '⇧',
  alt: isMac() ? '⌥' : 'Alt',
  enter: '⏎',
  escape: 'Esc',
  arrowup: '↑',
  arrowdown: '↓',
};

/** `'mod+shift+d'` -> `'⌘⇧D'` on Mac, `'Ctrl+Shift+D'` elsewhere. */
export function formatCombo(combo: string): string {
  const parts = combo.split('+').map((part) => {
    const key = part.toLowerCase();
    return SYMBOLS[key] ?? part.toUpperCase();
  });
  return parts.join(isMac() ? '' : '+');
}

/**
 * A small platform-correct key-hint pill. Every shortcut in this product is
 * also a visible, clickable control with one of these rendered beside it —
 * a shortcut that lives only in a hidden overlay does not exist.
 */
export function ShortcutHint({ combo }: { combo: string }): JSX.Element {
  return (
    <kbd className="inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[12px] leading-4 text-fg-muted">
      {formatCombo(combo)}
    </kbd>
  );
}
