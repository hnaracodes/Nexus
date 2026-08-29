/**
 * The single source of colour truth, mirroring design-system/nexus/MASTER.md.
 * CSS consumes these through the custom properties in index.css; TypeScript
 * consumes them here. Two copies of the same values is deliberate — Tailwind
 * cannot read a .ts file at build time without a plugin, and a plugin is a
 * larger dependency than a twelve-line duplicate.
 */
export const COLORS = {
  bg: '#131316',
  surface: '#1A1A1E',
  surface2: '#24242A',
  muted: '#1E1E23',
  border: '#2E2E36',
  /* Interactive boundaries only — WCAG 1.4.11 wants 3:1 on anything a person
     can operate. `border` is a divider and is deliberately below that. */
  borderStrong: '#6A6A75',
  fg: '#E8E8EC',
  fgMuted: '#9B9BA6',
  /* Ember owns interactive/identity; `success` owns approved/running. Splitting
     them is semantic, not decorative — see index.css for the reasoning. */
  accent: '#F0883E',
  accentDim: '#3A2113',
  onAccent: '#14100B',
  success: '#46C46A',
  /* Landing spectrum. The room uses `accent` alone; marketing opens out into
     all four. Never used alone for body text on --bg; the headline gradient is
     large-text only (3:1 floor). */
  accent2: '#E879F9',
  accent3: '#A78BFA',
  lime: '#A3E635',
  /* The blob character. Deliberately outside the brand spectrum — he is a
     character in the product, not a piece of its chrome. */
  nexus: '#5AA9FF',
  warn: '#E3B341',
  /* Rose, not red: a true red sits 1.2:1 from ember and the two become
     indistinguishable from each other. */
  danger: '#FB7185',
  info: '#58B8F0',
} as const;

/**
 * Evenly spaced around the wheel, skipping two bands so a participant avatar is
 * never mistaken for a semantic colour: 100-140 (--success, hue 133) and
 * 15-35 (--accent, hue 25) and 340-360 (--danger, hue 351).
 */
export const AVATAR_HUES = [52, 78, 100, 168, 190, 210, 235, 262, 288, 312] as const;
