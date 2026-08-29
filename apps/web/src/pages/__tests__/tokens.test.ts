import { describe, expect, it } from 'vitest';
import { COLORS, AVATAR_HUES } from '../../design/tokens.js';

describe('design tokens', () => {
  it('exposes every semantic colour the design system names', () => {
    for (const key of ['bg', 'surface', 'surface2', 'muted', 'border',
                       'fg', 'fgMuted', 'accent', 'accentDim',
                       'warn', 'danger', 'info'] as const) {
      expect(COLORS[key]).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('offers enough distinct avatar hues that a small room has no collision', () => {
    expect(AVATAR_HUES.length).toBeGreaterThanOrEqual(8);
    expect(new Set(AVATAR_HUES).size).toBe(AVATAR_HUES.length);
  });
});
