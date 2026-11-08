import type { KeyboardEvent } from 'react';
import { useResizable } from '../hooks/useResizable.js';
import { clamp } from '../layout/dimensions.js';

const KEY_STEP = 16;

/**
 * A draggable divider. `orientation` is the divider's own orientation: a
 * `vertical` divider sits between side-by-side regions and resizes horizontally.
 * Also operable from the keyboard (arrow keys) so resizing is not mouse-only.
 */
export function ResizeHandle({
  label,
  orientation,
  value,
  min,
  max,
  invert,
  onChange,
}: {
  label: string;
  orientation: 'vertical' | 'horizontal';
  value: number;
  min: number;
  max: number;
  invert?: boolean;
  onChange: (next: number) => void;
}): JSX.Element {
  const axis = orientation === 'vertical' ? 'x' : 'y';
  const { onMouseDown } = useResizable({
    value,
    min,
    max,
    axis,
    ...(invert === undefined ? {} : { invert }),
    onChange,
  });

  function onKeyDown(event: KeyboardEvent): void {
    const inv = invert === true;
    const grow = orientation === 'vertical' ? (inv ? 'ArrowLeft' : 'ArrowRight') : inv ? 'ArrowUp' : 'ArrowDown';
    const shrink = orientation === 'vertical' ? (inv ? 'ArrowRight' : 'ArrowLeft') : inv ? 'ArrowDown' : 'ArrowUp';
    if (event.key === grow) {
      event.preventDefault();
      onChange(clamp(value + KEY_STEP, min, max));
    } else if (event.key === shrink) {
      event.preventDefault();
      onChange(clamp(value - KEY_STEP, min, max));
    }
  }

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      className={`shrink-0 bg-transparent transition-colors hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none ${
        orientation === 'vertical' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
      }`}
    />
  );
}
