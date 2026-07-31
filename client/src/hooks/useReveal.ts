import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

interface RevealOptions {
  /** Stagger direct children instead of revealing the element as one block. */
  stagger?: boolean;
  /** Fraction of the element that must be visible before revealing. */
  threshold?: number;
}

/** Design DB "Standard" scroll-reveal: don't stagger more than ~8 children. */
const MAX_STAGGER_CHILDREN = 8;
const STAGGER_STEP_MS = 80;

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Reveal-on-scroll for the marketing pages.
 *
 * The markup ships **visible**. This hook adds the `reveal` class itself on
 * mount, so content is only ever hidden when JavaScript is running and about to
 * un-hide it — a crawler, a failed bundle, or a thrown error upstream all leave
 * a readable page rather than a blank one.
 *
 * It opts out entirely under `prefers-reduced-motion`, rather than relying on
 * the global reduced-motion override in index.css to collapse the transition:
 * that override zeroes the duration but would still leave the element starting
 * at opacity 0, which is a race worth not having.
 *
 * IntersectionObserver is absent in jsdom, so its absence is treated the same
 * as reduced motion — the element simply stays visible and every test asserting
 * on text keeps working.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>(
  options: RevealOptions = {},
): RefObject<T> {
  const { stagger = false, threshold = 0.15 } = options;
  // useRef<T>(null) — not useRef<T | null>(null). Only the former yields the
  // RefObject<T> that a JSX `ref` accepts under these React 18 types.
  const ref = useRef<T>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') return undefined;

    const targets: HTMLElement[] = stagger
      ? (Array.from(element.children) as HTMLElement[])
      : [element];

    for (const [index, target] of targets.entries()) {
      target.classList.add('reveal');
      if (stagger && index < MAX_STAGGER_CHILDREN) {
        target.style.transitionDelay = `${index * STAGGER_STEP_MS}ms`;
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-visible');
          // One-shot: re-revealing on every scroll direction change is noise.
          observer.unobserve(entry.target);
        }
      },
      { threshold, rootMargin: '0px 0px -10% 0px' },
    );

    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [stagger, threshold]);

  return ref;
}
