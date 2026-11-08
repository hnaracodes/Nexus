/**
 * The shell's fixed and resizable dimensions, in pixels.
 *
 * Owned by the LAYOUT unit so a colour/theme change never has to touch layout
 * numbers (and vice versa). Tailwind cannot read these at build time, so
 * fixed-size chrome is also spelled as a class (`w-12` = 48); these constants
 * are what the resizable regions and their clamps actually use.
 */
export const ACTIVITY_BAR_WIDTH = 48;
export const TITLE_BAR_HEIGHT = 32;
export const TAB_HEIGHT = 35;
export const BREADCRUMB_HEIGHT = 22;
export const STATUS_BAR_HEIGHT = 22;

export interface ResizeRange {
  default: number;
  min: number;
  max: number;
}

/** Left side bar (Explorer / Search / Source Control). */
export const SIDE_BAR: ResizeRange = { default: 260, min: 170, max: 480 };
/** Right auxiliary bar (Chat / Approvals / Fleet). The minimum keeps the
 *  approval buttons visible. */
export const AUX_BAR: ResizeRange = { default: 380, min: 280, max: 720 };
/** Bottom panel. `collapsed` is the header-only height — never zero, so the
 *  control that reopens it is always reachable. */
export const PANEL: ResizeRange & { collapsed: number } = { default: 240, min: 120, max: 640, collapsed: 35 };

export function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

export function clampTo(range: ResizeRange, value: number): number {
  return clamp(value, range.min, range.max);
}
