/**
 * The single source of colour truth, mirroring design-system/nexus/MASTER.md.
 * CSS consumes these through the custom properties in index.css; TypeScript
 * consumes them here. Two copies of the same values is deliberate — Tailwind
 * cannot read a .ts file at build time without a plugin, and a plugin is a
 * larger dependency than a duplicate (guarded by pages/__tests__/tokens.test.ts).
 */
export const COLORS = {
  /* VS Code Dark+ / Dark Modern. Values only change here; names are stable. */
  bg: '#1E1E1E',
  surface: '#252526',
  surface2: '#2A2D2E',
  muted: '#2D2D2D',
  border: '#3C3C3C',
  /* Interactive boundaries only — WCAG 1.4.11 wants 3:1 on anything a person
     can operate. `border` is a divider and is deliberately below that. */
  borderStrong: '#6E6E6E',
  fg: '#CCCCCC',
  fgMuted: '#9D9D9D',
  /* `accent` is a FILL (buttons, badges, top bars). It is only 3.6:1 on `bg`,
     so accent-coloured TEXT uses `accentFg`. `success` owns approved/running. */
  accent: '#0078D4',
  accentDim: '#04395E',
  onAccent: '#FFFFFF',
  success: '#89D185',
  /* Marketing spectrum, all drawn from the Dark+ syntax palette. */
  accent2: '#C586C0',
  accent3: '#569CD6',
  lime: '#B5CEA8',
  /* The blob character. Deliberately outside the brand spectrum. */
  nexus: '#5AA9FF',
  warn: '#CCA700',
  danger: '#F48771',
  info: '#3794FF',

  /* --- shell tokens (phase 18b) --- */
  accentFg: '#3794FF',
  accentHover: '#1177BB',
  activity: '#333333',
  activityFg: '#858585',
  activityFgActive: '#FFFFFF',
  titlebar: '#3C3C3C',
  tabStrip: '#252526',
  tabInactive: '#2D2D2D',
  tabActive: '#1E1E1E',
  status: '#007ACC',
  statusFg: '#FFFFFF',
  statusAlert: '#9E6A03',
  statusError: '#C72E0F',
  input: '#3C3C3C',
  selection: '#264F78',

  /* --- COLORS-only (no CSS var): CodeMirror Dark+ --- */
  synKeyword: '#569CD6',
  synControl: '#C586C0',
  synString: '#CE9178',
  synComment: '#6A9955',
  synNumber: '#B5CEA8',
  synType: '#4EC9B0',
  synFunction: '#DCDCAA',
  synVariable: '#9CDCFE',
  synConstant: '#4FC1FF',
  synRegexp: '#D16969',
  synOperator: '#D4D4D4',
  synCursor: '#AEAFAD',
  editorLineHighlight: '#FFFFFF0A',
  editorGutterFg: '#858585',
  editorGutterActiveFg: '#C6C6C6',
  editorBracketMatchBg: '#0064001A',
  editorBracketMatchBorder: '#888888',
} as const;

/**
 * Evenly spaced around the wheel, skipping two bands so a participant avatar is
 * never mistaken for a semantic colour: 100-140 (--success, hue 133) and
 * 15-35 (--accent, hue 25) and 340-360 (--danger, hue 351).
 */
export const AVATAR_HUES = [52, 78, 100, 168, 190, 210, 235, 262, 288, 312] as const;

/**
 * Pixel dimensions for the VS Code-shaped shell (phase 17a): the activity
 * bar, side bar and bottom panel. These are numbers, not Tailwind classes,
 * because the panel's height is user-resizable by drag — that state has to
 * live in JS and drive an inline style, so its bounds belong beside it
 * rather than scattered across `App.tsx` as magic numbers. `activityBarWidth`
 * and `statusBarHeight` are fixed today (Tailwind's own `w-12`/`h-6`
 * utilities already match them) but are named here too, so the whole
 * shell's proportions read as one system rather than half tokens and half
 * literals.
 */
export const LAYOUT = {
  /** Region A — the icon rail. Fixed; VS Code's activity bar never resizes. */
  activityBarWidth: 48,
  /** Region B — the side bar's width. Fixed for now (drag-resize is a later
   *  phase's problem) — the constant exists so that phase has one number to
   *  change rather than a class hunted down across the tree. */
  sideBarWidth: 260,
  /** Region D — the panel, drag-resizable between these bounds. */
  panelDefaultHeight: 260,
  panelMinHeight: 120,
  panelMaxHeight: 640,
  /** Collapsed, the panel still shows its header bar — never zero, so the
   *  control to reopen it is always reachable. */
  panelCollapsedHeight: 36,
  /** Region E — the status bar. */
  statusBarHeight: 24,
} as const;
