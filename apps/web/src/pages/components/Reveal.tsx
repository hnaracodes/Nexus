import type { ReactNode } from 'react';
import { useReveal } from '../../hooks/useReveal.js';

/**
 * Wraps a landing section so it fades up as it enters the viewport. Kept as a
 * wrapper rather than pushed into each section so the sections stay plain
 * markup — and so a section rendered outside the landing page (or in a test)
 * has no motion behaviour attached to it at all.
 */
export function Reveal({ children }: { children: ReactNode }): JSX.Element {
  const ref = useReveal<HTMLDivElement>();
  return <div ref={ref}>{children}</div>;
}
