import { useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { clamp } from '../layout/dimensions.js';

export interface UseResizableOptions {
  /** Current size in px. */
  value: number;
  min: number;
  max: number;
  /** `x` tracks clientX (a vertical divider), `y` tracks clientY. */
  axis: 'x' | 'y';
  /** Dragging toward the origin grows the region (a right-hand bar or a bottom panel). */
  invert?: boolean;
  onChange: (next: number) => void;
}

/**
 * Drag-to-resize, clamped. Listeners live on `window`, not the handle: a real
 * drag routinely leaves the few-pixel-wide handle and a handle-scoped listener
 * would stop tracking the moment that happens. `onChange` is read through a
 * ref so a re-render never detaches an in-flight drag.
 */
export function useResizable(options: UseResizableOptions): {
  onMouseDown: (event: ReactMouseEvent) => void;
} {
  const latest = useRef(options);
  latest.current = options;
  const drag = useRef<{ start: number; startValue: number } | null>(null);

  useEffect(() => {
    function onMove(event: MouseEvent): void {
      const state = drag.current;
      if (state === null) return;
      const { axis, invert, min, max, onChange } = latest.current;
      const pos = axis === 'x' ? event.clientX : event.clientY;
      const delta = (pos - state.start) * (invert === true ? -1 : 1);
      onChange(clamp(state.startValue + delta, min, max));
    }
    function onUp(): void {
      drag.current = null;
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  return {
    onMouseDown(event) {
      const { axis, value } = latest.current;
      event.preventDefault();
      drag.current = { start: axis === 'x' ? event.clientX : event.clientY, startValue: value };
    },
  };
}
