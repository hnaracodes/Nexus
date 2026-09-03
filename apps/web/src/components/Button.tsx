import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * The room's one button vocabulary.
 *
 * Before this, every control hand-rolled its own classes and they had drifted:
 * some carried a focus ring and some did not, radii ranged from 2px to 6px, and
 * one control (StopButton) sat below the 44px touch floor for two phases. A
 * shared component makes the floor structural rather than a thing each author
 * has to remember.
 *
 * Radius is 10px — enough curve to read as soft against the room's hard
 * editor-like panels, not so much that a dense toolbar turns into a row of
 * pills. Icon-only controls go fully round instead, because a circle is
 * unambiguous at 28px where a rounded square is just a blurry square.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
export type ButtonSize = 'sm' | 'md';

const BASE =
  'inline-flex items-center justify-center gap-2 font-medium ' +
  // The 44px floor lives here so no caller can forget it.
  'min-h-11 rounded-[10px] ' +
  'transition-[background-color,border-color,box-shadow,transform] duration-150 ease-emphasis ' +
  // A press should feel like a press. 1px is enough to register and small
  // enough that the reduced-motion override below makes it vanish cleanly.
  'active:translate-y-px ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg ' +
  'disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0';

const SIZES: Record<ButtonSize, string> = {
  sm: 'px-3 text-[13px]',
  md: 'px-4 text-sm',
};

const VARIANTS: Record<ButtonVariant, string> = {
  // Solid accent with a near-black label — white on #6AA5FF is 2.4:1 and
  // unreadable. The inset highlight is a single hairline, not a gradient:
  // enough to give the fill a light source, cheap enough to stay crisp.
  primary:
    'bg-accent text-on-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] ' +
    'hover:brightness-110 active:brightness-95',
  // border-strong, not border: this is an operable control and WCAG 1.4.11
  // wants 3:1 on its boundary.
  secondary:
    'bg-surface-2 text-fg border border-border-strong ' +
    'hover:bg-muted hover:border-fg-muted',
  ghost: 'bg-transparent text-fg-muted hover:bg-surface-2 hover:text-fg',
  // Tinted rather than solid. A destructive control should be legible as
  // destructive without shouting over the transcript it sits beside; the solid
  // fill is reserved for the confirm step.
  danger:
    'bg-transparent text-danger border border-danger/45 ' +
    'hover:bg-danger/12 hover:border-danger',
  success:
    'bg-transparent text-success border border-success/45 ' +
    'hover:bg-success/12 hover:border-success',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  type = 'button',
  children,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    // eslint-disable-next-line react/button-has-type -- `type` is defaulted above.
    <button
      type={type}
      className={`${BASE} ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * Icon-only. Square footprint, fully round, and an `aria-label` is required
 * rather than optional — an icon button with no accessible name is invisible
 * to a screen reader, and this room is meant to be operable without a mouse.
 */
export function IconButton({
  label,
  className = '',
  children,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={
        'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full ' +
        'text-fg-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ' +
        'focus-visible:ring-offset-2 focus-visible:ring-offset-bg ' +
        'disabled:cursor-not-allowed disabled:opacity-50 ' +
        className
      }
      {...rest}
    >
      {children}
    </button>
  );
}
