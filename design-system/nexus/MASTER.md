# Nexus Design System — Master

**Global source of truth for both surfaces.** Page-specific overrides live in
`design-system/nexus/pages/<page>.md` and win over this file where they conflict.
Consumed by `docs/plans/phase-5a-marketing-site.md` (marketing + legal) and
`docs/plans/phase-5b-room-ui-redesign.md` (the room).

Derived from the `ui-ux-pro-max` database, queried twice:

| Surface | Query | Resolved pattern / style |
|---|---|---|
| Marketing | `developer tool SaaS landing page technical governance security trust dark minimal` (variance 6, motion 6, density 3) | **Trust & Authority + Conversion** |
| Room | `realtime collaborative developer console multiplayer presence dark dashboard` (variance 4, motion 4, density 8) | **Modern Dark** |

Both queries resolved to the **same palette and the same typeface**. That is the
central fact of this design system: one token set serves both surfaces, and they
differ only in **density and motion**, not in colour or type. A visitor who
clicks "Open a room" should feel they stayed in the same product.

---

## 1. Colour tokens

Defined once as CSS custom properties in `client/src/index.css`, exposed to
Tailwind via `tailwind.config.js` `theme.extend.colors` so utilities read
`bg-surface`, `text-fg-muted`, `border-border` rather than raw hex.

| Token | Hex | Tailwind key | Use |
|---|---|---|---|
| `--bg` | `#131316` | `bg` | page background |
| `--surface` | `#1A1A1E` | `surface` | cards, panels, message rows |
| `--surface-2` | `#24242A` | `surface-2` | raised, hover, active |
| `--muted` | `#1E1E23` | `muted` | inert fills, disabled |
| `--border` | `#2E2E36` | `border` | dividers, card edges — decorative only |
| `--border-strong` | `#6A6A75` | `border-strong` | **operable** boundaries: inputs, secondary buttons |
| `--fg` | `#E8E8EC` | `fg` | primary text |
| `--fg-muted` | `#9B9BA6` | `fg-muted` | secondary text |
| `--accent` | `#F0883E` | `accent` | brand + interactive: CTA, links, driver token, focus ring |
| `--accent-dim` | `#3A2113` | `accent-dim` | accent backgrounds at low emphasis |
| `--on-accent` | `#14100B` | `on-accent` | label colour on a solid `--accent` fill |
| `--success` | `#46C46A` | `success` | **approved**, agent running |
| `--warn` | `#E3B341` | `warn` | permission requests, security callouts |
| `--danger` | `#FB7185` | `danger` | denials, errors, destructive tools |
| `--info` | `#58B8F0` | `info` | neutral notices |
| `--accent-2` | `#E879F9` | `accent-2` | landing spectrum — marketing only |
| `--accent-3` | `#A78BFA` | `accent-3` | landing spectrum — marketing only |
| `--lime` | `#A3E635` | `lime` | landing spectrum — marketing only |
| `--nexus` | `#5AA9FF` | `nexus` | the blob character, and only him |

### Why the accent is not green

Green previously did four jobs at once — driver token, agent running, primary
CTA, **and approved-state** — so "this is a button" and "this was approved"
rendered identically. In a product whose whole premise is that people can see
what the agent is about to do, that is a correctness problem, not a taste one.

Ember now owns interactive/identity. `--success` owns approved/running and
nothing else. Approve / deny / pending finally read as one set.

### Why the danger colour is rose, not red

**Contrast between accents matters as much as contrast against the background,
and almost nobody checks it.** A conventional red (`#F0655C`, hue 4) sits at
**1.23:1** against ember (hue 25). Both pass AA against `--bg` individually and
are nearly indistinguishable from each other — so "primary action" and
"destructive action" would have looked alike. `#FB7185` (hue 351) is the fix.

### The character is deliberately off-palette

`--nexus` is the only blue in a warm system. He is a *character in* the product,
not a piece of its chrome; the cool blue is what makes him read as someone
rather than as a UI element. Never use `--nexus` for interface state.

### Tokens are CHANNEL TRIPLETS, and that is load-bearing

`index.css` defines every colour as raw channels — `--accent: 240 136 62;` — and
`tailwind.config.js` consumes them as `rgb(var(--accent) / <alpha-value>)`.

This is not a style preference. **Tailwind can only honour an opacity modifier
(`bg-danger/70`, `border-accent/45`, `bg-surface/60`) when the colour is in that
form.** While the tokens held hex strings, every such class compiled to *nothing*
and the build stayed green — buttons shipped with no border and no hover state,
card borders vanished, and a window-chrome detail was simply invisible. Several
of the dead classes predated the repalette by two phases.

Consequences to remember:

- In plain CSS or an inline style, write `rgb(var(--accent))`, never
  `var(--accent)` — the bare value is `240 136 62`, which is not a colour.
- The same applies inside SVG presentation attributes.
- `client/src/design/tokens.ts` keeps the **hex** copies. That duplication is
  deliberate: Shiki needs real hex for its theme, and humans need something
  readable. If you change a colour, change both.

### Rules that are not negotiable

- **Never pure `#000000`.** `--bg` is `#0F172A`. Pure black smears on OLED and
  reads as "unstyled" rather than "dark".
- **Semantic tokens only in components.** No raw hex in TSX. A component that
  needs a colour the table lacks means the table needs a token, not an inline
  value.
- **Colour never carries meaning alone.** Every state that uses colour also
  carries an icon or a text label. A denied approval says "Denied" with an
  `XCircle`; it is not merely red. This is both an accessibility requirement and
  a correctness one — this product's whole premise is that people can tell what
  the agent is about to do.

### Measured contrast (WCAG 2.1 AA)

Computed, not eyeballed — every pair below was run through a relative-luminance
calculator on 2026-08-03.

| Pair | Ratio | Verdict |
|---|---|---|
| `--fg` on `--bg` | 15.18:1 | AAA |
| `--fg-muted` on `--bg` | 6.74:1 | AA |
| `--fg-muted` on `--surface-2` | 5.61:1 | AA |
| `--accent` on `--bg` | 7.33:1 | AAA |
| `--accent` on `--surface-2` | 6.10:1 | AA |
| `--on-accent` on `--accent` (primary button) | 7.48:1 | AAA |
| `--success` on `--bg` | 8.27:1 | AAA |
| `--warn` on `--bg` | 9.53:1 | AAA |
| `--danger` on `--bg` | 5.94:1 | AA |
| `--info` on `--bg` | 8.42:1 | AAA |
| `--accent-2` on `--bg` | 7.54:1 | AAA |
| `--accent-3` on `--bg` | 6.81:1 | AA |
| `--lime` on `--bg` | 12.30:1 | AAA |
| `--nexus` on `--bg` | 7.55:1 | AAA |
| `--border-strong` on `--bg` | 3.47:1 | passes **1.4.11** (UI boundary, not text) |
| `--border` on `--bg` | 1.38:1 | decorative divider only — never a control edge |

Marketing light mode, all against `#FFFFFF`: `--fg` 18.54, `--fg-muted` 7.16,
`--accent` (`#B4530F`) 5.02, `--accent-2` 6.32, `--accent-3` 7.10, `--success`
5.02, `--danger` 5.63, `--warn` 5.93. White on light `--accent` is 5.02:1.

## 2. Typography

**Inter** for everything, weights 300/400/500/600/700, `font-display: swap` with
a matched system fallback so there is no layout shift when it loads.

```css
--font-sans: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
--font-mono: ui-monospace, 'SFMono-Regular', 'Menlo', 'Consolas', monospace;
```

Mono is used for tool input and output, room ids, API-key fields, keyboard hints,
and anything the user might copy. Prose is never mono.

| Role | Size / line-height / weight | Surface |
|---|---|---|
| Display | 56–72px / 1.05 / 700, `-0.02em` | landing hero |
| H1 | 36px / 1.15 / 600 | page titles |
| H2 | 28px / 1.25 / 600 | section headings |
| H3 | 20px / 1.35 / 600 | card titles |
| Body-lg | 18px / 1.6 / 400 | landing prose |
| Body | 16px / 1.5 / 400 | default, legal docs |
| Body-sm | 14px / 1.5 / 400 | room UI default |
| Caption | 12px / 1.4 / 500 | timestamps, key hints, metadata **only** |
| Mono | 13px / 1.5 / 400 | tool I/O, ids |

**16px is the floor for anything a user reads as prose.** 12px is permitted only
for metadata that is redundant with something larger. Legal documents use 16px
body and a 65–75 character measure (`max-w-[68ch]`) — a privacy policy nobody
can read is a dark pattern regardless of intent.

Headings must descend in order (`h1` → `h2` → `h3`). Never pick a heading level
for its size; pick it for its position in the outline and style it with a class.

---

## 3. Spacing and density

One 4px-based scale, two densities.

| Step | Value | Marketing use | Room use |
|---|---|---|---|
| `1` | 4px | — | icon gaps |
| `2` | 8px | — | inline gaps, chip padding |
| `3` | 12px | — | control padding |
| `4` | 16px | inline gaps | card padding, row gaps |
| `6` | 24px | card padding | section gaps |
| `8` | 32px | block gaps | max room gap |
| `12` | 48px | sub-section | — |
| `16` | 64px | section padding | — |
| `24` | 96px | major section | — |

- **Marketing** lives in 24–96px. Generous, one idea per screenful.
- **Room** lives in 8–32px. Dense — this is an operations console, and vertical
  space spent on padding is transcript the room cannot see.

Radii: `4px` controls, `8px` cards, `12px` modals and the hero mock, `9999px`
pills and avatars. Never mix a 4px and a 12px radius in the same component.

Elevation is border-first, shadow-second: `--surface` + `1px --border` for a
resting card; add `box-shadow: 0 8px 24px rgb(0 0 0 / 0.4)` only for genuinely
floating layers (modal, palette, toast). Dark UIs read depth from border
contrast far better than from shadow.

Z-index scale, and nothing outside it: `10` sticky header · `20` side rail
overlay · `30` toasts · `40` approval modal · `50` command palette. No
`z-[9999]`.

---

## 4. Motion

CSS transitions only. **No GSAP, no Framer Motion, no animation dependency.**

| Property | Value |
|---|---|
| Micro (hover, focus, colour) | 150ms `ease-out` |
| Standard (enter, expand, slide) | 250ms `cubic-bezier(0.16, 1, 0.3, 1)` |
| Exit | 150ms `ease-in` — exits are always faster than entrances |
| Stagger (list reveal) | 40ms per item, cap the run at 6 items |

Animate `transform` and `opacity` only. Never animate `width`, `height`, `top`,
or `left` — they trigger layout on every frame.

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

### Marketing motion (landing and legal pages only)

Implemented in CSS plus one `IntersectionObserver` hook (`useReveal`) — no GSAP,
no animation dependency. The values come from the design DB's *Standard*
scroll-reveal and Bento hover presets.

| Effect | Utility | Values |
|---|---|---|
| Scroll reveal | `.reveal` / `.is-visible` | opacity 0→1, y 24→0, 500ms, `cubic-bezier(0.16,1,0.3,1)` |
| Stagger | `useReveal({stagger:true})` | 80ms per child, capped at 8 children |
| Ambient mesh | `.nexus-blob-a` / `-b` | blurred accent blobs, 22s/27s drift, opacity ≤0.20 |
| Headline gradient | `.text-gradient` | `--fg` → `--accent` → `--accent-3`, large text only |
| CTA glow | `.glow-accent` | shadow expansion + 2px lift, 250ms |
| Card lift | `.card-lift` | 4px lift + shadow, 200ms |

`useReveal` adds the `.reveal` class **itself, on mount**. Markup therefore
ships visible: a crawler, a failed bundle, or an error upstream leaves a
readable page rather than a blank one. The hook opts out entirely under
`prefers-reduced-motion` rather than relying on the global override.

**The reduced-motion fallback must not remove information.** The agent-activity
indicator pulses when the agent is working — with motion disabled, the pulse
stops but the dot and its text label ("thinking…", "running Bash · 4s") remain.
If disabling animation makes a state unreadable, the state was encoded in the
animation, which is a bug.

---

## 5. Icons

**`lucide-react`** — the only new frontend dependency, tree-shaken per-import.

No emoji as icons, anywhere. The current 🚗 driver badge in `Roster.tsx` is the
exact anti-pattern: emoji render differently per platform, ignore `currentColor`,
and are announced unpredictably by screen readers.

| Meaning | Icon | Colour |
|---|---|---|
| Driver / has the token | `Crown` | `--accent` |
| Requesting control | `Hand` | `--fg-muted` |
| Participant | `User` / `Users` | per-avatar hue |
| Agent working | `Loader` (spin) or `Circle` (filled, pulsing) | `--accent` |
| Permission requested | `ShieldAlert` | `--warn` |
| Approved | `CheckCircle2` | `--accent` |
| Denied / expired | `XCircle` | `--danger` |
| Destructive tool | `AlertTriangle` | `--danger` |
| Error | `AlertOctagon` | `--danger` |
| Info notice | `Info` | `--info` |
| Connection live | `Wifi` | `--accent` |
| Reconnecting | `WifiOff` | `--warn` |
| API key / secret | `KeyRound` | `--fg-muted` |
| Security boundary | `ShieldAlert` | `--warn` |
| Interrupt / stop | `Square` (filled) | `--danger` |
| Room switcher | `Command` | `--fg-muted` |
| Copy link | `Link2` / `Check` on success | `--fg-muted` → `--accent` |

Default `size={16}` in the room, `size={20}` on marketing, `strokeWidth={2}`.
Icons inherit `currentColor`. Every icon-only control carries an `aria-label`
**and** a `title`.

---

## 6. Interaction and accessibility floor

Non-negotiable, checked before either plan is called done:

- **Focus is always visible.** `focus-visible:ring-2 ring-accent ring-offset-2
  ring-offset-bg` on every interactive element. `outline: none` without a
  replacement is a defect, not a style choice.
- **44×44px minimum hit target**, 8px minimum between adjacent targets. Small
  visual controls get padding to reach it.
- **Keyboard reaches everything.** Tab order follows visual order. No traps. A
  skip-to-content link on marketing pages.
- **`cursor-pointer` on everything clickable.** Hover transitions 150ms.
- **Loading feedback above 300ms.** Never a frozen control — disable it and show
  its busy state.
- **Errors sit next to their cause,** not only in a banner at the top.
- **Labels are visible.** Placeholder-only labelling is not labelling.
- **Alt text on meaningful images**, `alt=""` on decorative ones.
- **Breakpoints:** 375 / 768 / 1024 / 1440. Mobile-first. No horizontal page
  scroll at any width; wide content (tool output, code) scrolls inside its own
  `overflow-x:auto` container.
- **Live regions:** the transcript is `aria-live="polite"`; a new permission
  request is `aria-live="assertive"` because it blocks the whole room.

---

## 7. Voice

Applies to every string in both surfaces.

- **Plain and specific.** "Ben denied Bash — no reason given", not "Action
  processed".
- **Never oversell.** This project has never been deployed. No "trusted by",
  no invented metrics, no testimonials, no fake logos. The audience is
  developers, who detect fabricated social proof instantly and discount
  everything else on the page with it.
- **State the security model in full, early, and without softening.** The
  verbatim `BUILD_SPEC.md` §8 lines — *"A shared room is a shared security
  boundary"* and *"The MVP has no isolation between rooms"* — are load-bearing
  product copy, not fine print.
- **Errors say what happened and what to do next.** "The room lost its API key
  when the server restarted. Re-enter it to continue." plus a button beats
  "Error 4409".
