/**
 * The single source of colour truth, mirroring design-system/nexus/MASTER.md.
 * CSS consumes these through the custom properties in index.css; TypeScript
 * consumes them here. Two copies of the same values is deliberate — Tailwind
 * cannot read a .ts file at build time without a plugin, and a plugin is a
 * larger dependency than a twelve-line duplicate.
 */
export const COLORS = {
  bg: '#0F172A',
  surface: '#1E293B',
  surface2: '#334155',
  muted: '#272F42',
  border: '#475569',
  fg: '#F8FAFC',
  fgMuted: '#94A3B8',
  accent: '#22C55E',
  accentDim: '#166534',
  /* Gradient partners for the marketing surface. Never used alone for text on
     --bg at body size; the headline gradient is large-text only (3:1 floor). */
  accent2: '#6366F1',
  accent3: '#22D3EE',
  warn: '#F59E0B',
  danger: '#EF4444',
  info: '#38BDF8',
} as const;

/**
 * Evenly spaced around the wheel, skipping the 100-140 band so a participant
 * avatar is never mistaken for the driver accent (--accent is hue 142).
 */
export const AVATAR_HUES = [8, 32, 52, 190, 210, 232, 262, 290, 318, 344] as const;
