import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * A single keyboard shortcut. `combo` is a `+`-joined, order-independent
 * token list, e.g. `'mod+k'`, `'mod+shift+d'`, `'escape'`, `'?'`. `mod` means
 * "the platform's primary modifier" — see {@link isMac}.
 */
export interface Hotkey {
  combo: string;
  handler: (event: KeyboardEvent) => void;
  /** Fire even while focus is in an input/textarea/contenteditable. Default false. */
  allowInInput?: boolean;
  /** Rendered in the cheatsheet and nowhere else. */
  description: string;
  /**
   * Optional gate evaluated BEFORE `preventDefault()` and the handler. Return
   * false to decline: the browser keeps the key (e.g. Cmd+Shift+V pasting as
   * plain text in the prompt box) and any later matching hotkey is tried.
   */
  when?: (event: KeyboardEvent) => boolean;
}

/**
 * True on macOS. `navigator.userAgentData` is preferred where present (it is
 * not spoofed the way `navigator.platform` can be); both are absent in some
 * test environments, in which case this — correctly — reports false.
 */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform ?? navigator.platform ?? '';
  return /mac/i.test(platform);
}

interface ParsedCombo {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split('+').map((part) => part.trim());
  const key = parts[parts.length - 1] ?? '';
  return {
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    key,
  };
}

function modKeyPressed(event: KeyboardEvent): boolean {
  return isMac() ? event.metaKey : event.ctrlKey;
}

/** Symbols like `?` are typed WITH shift on most layouts, so a combo that
 *  names only the symbol must not be rejected for the shift it implies. */
function isShiftedSymbol(key: string): boolean {
  return key.length === 1 && !/[a-z0-9]/i.test(key);
}

/**
 * Exact-modifier match. The old check only required the combo's modifiers to
 * be PRESENT, so `mod+b` also fired for `mod+alt+b` and `mod+d` shadowed
 * `mod+shift+d`. Extra modifiers now reject.
 */
function matchesCombo(event: KeyboardEvent, parsed: ParsedCombo): boolean {
  if (parsed.mod !== modKeyPressed(event)) return false;
  if (parsed.alt !== event.altKey) return false;
  if (!isShiftedSymbol(parsed.key) && parsed.shift !== event.shiftKey) return false;
  if (event.key.toLowerCase() === parsed.key) return true;
  // macOS Option+letter yields a different `key` (Option+B is 'ß'); the
  // physical key code is still reliable.
  return parsed.alt && /^[a-z]$/.test(parsed.key) && event.code === `Key${parsed.key.toUpperCase()}`;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

/**
 * Registers a set of keyboard shortcuts on `document`, or — pass `scopeRef`
 * — on a single element instead. Scoping to an element is how a component
 * keeps a shortcut strictly local: attach the listener to a focused card's
 * own container (not `document`) and a keydown only reaches it while that
 * card, or something inside it, holds focus. This is how `a`/`d`
 * approve/deny must be wired — never registered globally, because a global
 * `d` would let someone deny (or `a` approve) a destructive tool call by
 * typing a word while focus sat on the page body.
 *
 * `preventDefault` is called only when a combo actually matches, so keys
 * this app does not handle reach the browser untouched.
 */
export function useHotkeys(
  hotkeys: Hotkey[],
  scopeRef?: RefObject<HTMLElement | null> | null,
): void {
  // The listener itself only needs to be (re)attached when the set of combos
  // genuinely changes — not on every render, which would happen if callers
  // pass a new inline array each time. The handlers themselves may still
  // close over fresh render-local state, so they are read through a ref that
  // is updated on every render rather than captured once at attach time.
  const signature = hotkeys
    .map((hotkey) => `${hotkey.combo}:${hotkey.allowInInput ? 1 : 0}`)
    .join('|');

  const hotkeysRef = useRef(hotkeys);
  hotkeysRef.current = hotkeys;

  useEffect(() => {
    const target: Document | HTMLElement = scopeRef?.current ?? document;

    function onKeyDown(event: Event): void {
      const keyboardEvent = event as KeyboardEvent;
      const typing = isTypingTarget(keyboardEvent.target);
      for (const hotkey of hotkeysRef.current) {
        const parsed = parseCombo(hotkey.combo);
        if (!matchesCombo(keyboardEvent, parsed)) continue;
        if (typing && !hotkey.allowInInput) continue;
        if (hotkey.when !== undefined && !hotkey.when(keyboardEvent)) continue;
        keyboardEvent.preventDefault();
        hotkey.handler(keyboardEvent);
        return;
      }
    }

    target.addEventListener('keydown', onKeyDown);
    return () => target.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, scopeRef?.current]);
}
