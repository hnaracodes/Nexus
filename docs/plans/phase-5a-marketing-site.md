# Phase 5a — Marketing Site, Legal Docs and Room-Creation UX

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public landing page at `/`, legal documents at `/privacy`, `/terms` and `/security`, and a redesigned room-creation flow at `/new` — all served by the existing Node process from the existing Vite bundle, with no second build and no new deploy target.

**Why:** Nexus has no public face at all. `client/src/App.tsx:51-55` is a branch marked `phase-3c landing-page slot` that renders `<CreateRoom/>` when `?room=` is absent; that stopgap *is* the entire landing experience. More seriously, the product accepts a user's Anthropic API key, clones arbitrary git repositories, and writes every prompt anyone types into a permanent append-only log with **no deletion mechanism anywhere in `src/`** — and there is currently no document anywhere in this repo that tells a user that.

**Architecture:** A ~40-line hand-rolled router in `client/src/router.tsx` (no `react-router` for five static routes) plus an explicit route allow-list in `src/server/index.ts`. Design tokens land in `client/src/index.css` as CSS custom properties and are exposed to Tailwind through `theme.extend`, so both this plan and `phase-5b` consume one set of names. Legal copy is derived from the code, not from a template.

**Mode:** PARALLEL — dispatch alongside `phase-5b-room-ui-redesign.md`. The seam is `client/src/App.tsx` and `client/src/index.css`; see Global Constraints.

**Files owned:**
- `client/src/pages/**`
- `client/src/router.tsx`
- `client/src/design/**`
- `client/index.html`
- `client/tailwind.config.js`
- `client/src/index.css` — **only inside the `phase-5a tokens` marker region**
- `client/src/App.tsx` — **only inside the `phase-5a routing` marker region** and the `phase-5a import anchor` line
- `client/src/main.tsx`
- `src/server/index.ts` — **only the static-route block at lines 169-185**
- `tests/server/static-routes.test.ts`
- `client/src/pages/__tests__/**`
- `design-system/nexus/pages/**`

Anything outside these globs: stop and report `BLOCKED`.

---

## Global Constraints

- `npm test`, `npm run test:client`, `npm run typecheck` and `npm --prefix client run build` must **all** exit 0 before any commit. The client build is the only command that type-checks TSX — this repo has already shipped a `tsc -b` failure behind a fully green client suite.
- **Read `design-system/nexus/MASTER.md` first.** Every colour, size, spacing step, icon and motion duration in this plan comes from it. Do not invent a token; if you need one that is missing, report it in your final notes rather than inlining a hex value.
- **Shared-file discipline.** `phase-5b` is running concurrently and owns `client/src/components/**` and the rest of `App.tsx`. Edit only inside `{/* --- BEGIN phase-5a routing --- */}` … `{/* --- END phase-5a routing --- */}` in `App.tsx`, only inside `/* --- BEGIN phase-5a tokens --- */` … `/* --- END phase-5a tokens --- */` in `index.css`, and add imports only immediately below the line `// phase-5a import anchor`. Do not reformat, reorder or "tidy" anything else in those files.
- **I4 — API keys never reach the client, never hit the log, never enter a URL.** `CreateRoom` already POSTs the key in a request body and clears it from state on success (`CreateRoom.tsx:27`). Preserve both properties exactly. Never put a key in a query string, never write one to `localStorage`, never echo one into an error message you render.
- **The BYOK constraint is legal, not stylistic** (`BUILD_SPEC.md` §5.5). Anthropic's published policy states verbatim: *"Anthropic does not permit third-party developers to offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf of their users."* Console `sk-ant-…` keys only. This sentence appears on `/privacy` and at room creation.
- **Never weaken the security copy.** `BUILD_SPEC.md` §8 requires *"A shared room is a shared security boundary"* and *"The MVP has no isolation between rooms"* to appear plainly in the UI. Softening, shortening or burying either one fails this plan.
- **Invent nothing.** No testimonials, no customer logos, no "trusted by", no user counts, no uptime figures, no benchmark claims. Every factual statement on the site must be checkable against this repository. When you need a number and do not have one, remove the sentence.
- **`POST /api/rooms` is still unauthenticated** and drives an outbound `git clone` (newest `sessions/` `issues.md` §B). This plan makes it *easier* to reach, so the landing page must not be deployed publicly until that is hardened. Task 8 adds that warning to the README rather than leaving it implicit.

---

### Task 1: Design tokens and Tailwind theme

**Files:**
- Modify: `client/src/index.css` — add token definitions inside a new `phase-5a tokens` marker region
- Modify: `client/tailwind.config.js` — extend theme with semantic names
- Modify: `client/index.html` — font loading, meta tags, `referrer` policy
- Create: `client/src/design/tokens.ts` — the same values as typed constants for use in TS

**Interfaces:**
- Produces: Tailwind utilities `bg-bg`, `bg-surface`, `bg-surface-2`, `text-fg`, `text-fg-muted`, `border-border`, `text-accent`, `text-warn`, `text-danger`, `text-info` (and their `bg-`/`border-` counterparts), consumed by **both** this plan and `phase-5b`.
- Produces: `export const AVATAR_HUES: readonly number[]` in `tokens.ts`, consumed by `phase-5b`'s avatar module.

- [ ] **Step 1: Write the failing test**

  Create `client/src/pages/__tests__/tokens.test.ts`:

  ```ts
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
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm --prefix client test -- tokens`
  Expected: FAIL — `client/src/design/tokens.ts` does not exist.

- [ ] **Step 3: Write `client/src/design/tokens.ts`**

  ```ts
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
    warn: '#F59E0B',
    danger: '#EF4444',
    info: '#38BDF8',
  } as const;

  /**
   * Evenly spaced around the wheel, skipping the 100-140 band so a participant
   * avatar is never mistaken for the driver accent (--accent is hue 142).
   */
  export const AVATAR_HUES = [8, 32, 52, 190, 210, 232, 262, 290, 318, 344] as const;
  ```

- [ ] **Step 4: Add the token region to `client/src/index.css`**

  Replace the file's contents (it currently holds only the three `@tailwind` directives) with the directives plus a marked region. Keep the directives first.

  ```css
  @tailwind base;
  @tailwind components;
  @tailwind utilities;

  /* --- BEGIN phase-5a tokens --- */
  @layer base {
    :root {
      --bg: #0F172A;
      --surface: #1E293B;
      --surface-2: #334155;
      --muted: #272F42;
      --border: #475569;
      --fg: #F8FAFC;
      --fg-muted: #94A3B8;
      --accent: #22C55E;
      --accent-dim: #166534;
      --warn: #F59E0B;
      --danger: #EF4444;
      --info: #38BDF8;
      --font-sans: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
      --font-mono: ui-monospace, 'SFMono-Regular', 'Menlo', 'Consolas', monospace;
      color-scheme: dark;
    }

    /*
      Marketing pages only. The room is dark-only by design — it sits beside a
      terminal. `.surface-marketing` is set on the <body> by the router for the
      landing and legal routes, never for the room.
      Accent, warn and danger MUST darken here: #22C55E on white is 1.8:1.
    */
    @media (prefers-color-scheme: light) {
      .surface-marketing {
        --bg: #FFFFFF;
        --surface: #F8FAFC;
        --surface-2: #F1F5F9;
        --border: #CBD5E1;
        --fg: #0F172A;
        --fg-muted: #475569;
        --accent: #15803D;
        --warn: #B45309;
        --danger: #B91C1C;
        color-scheme: light;
      }
    }

    html { -webkit-text-size-adjust: 100%; }
    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--font-sans);
    }

    /* A focus ring is never removed, only restyled. */
    :focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
        scroll-behavior: auto !important;
      }
    }
  }
  /* --- END phase-5a tokens --- */
  ```

- [ ] **Step 5: Extend `client/tailwind.config.js`**

  The file currently has `content` set and an empty `theme.extend`. Fill it in; do not change `content`.

  ```js
  export default {
    content: ['./index.html', './src/**/*.{ts,tsx}'],
    theme: {
      extend: {
        colors: {
          bg: 'var(--bg)',
          surface: 'var(--surface)',
          'surface-2': 'var(--surface-2)',
          muted: 'var(--muted)',
          border: 'var(--border)',
          fg: 'var(--fg)',
          'fg-muted': 'var(--fg-muted)',
          accent: 'var(--accent)',
          'accent-dim': 'var(--accent-dim)',
          warn: 'var(--warn)',
          danger: 'var(--danger)',
          info: 'var(--info)',
        },
        fontFamily: {
          sans: ['var(--font-sans)'],
          mono: ['var(--font-mono)'],
        },
        maxWidth: { prose: '68ch' },
        transitionTimingFunction: { emphasis: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      },
    },
    plugins: [],
  };
  ```

  Note: Tailwind's default `border` utility resolves `border-color` from `theme.colors.border`; verify `border` and `border-border` both still compile after this change and prefer the explicit `border-border` in new markup.

- [ ] **Step 6: Update `client/index.html`**

  Add, inside `<head>`: `<meta name="referrer" content="no-referrer">` (the room token lives in the query string, so any outbound link would otherwise leak the credential in a `Referer` header — this is a real defect the site would introduce), a `<meta name="description">`, `<meta name="color-scheme" content="dark light">`, Open Graph and Twitter card tags, and the Inter font with `display=swap` and preconnect hints. Set `<html lang="en">`. Title: `Nexus — one agent, one context window, everyone in the room`.

- [ ] **Step 7: Run tests and commit**

  Run: `npm --prefix client test`, then `npm --prefix client run build`
  Expected: all pass, build exits 0.

  ```bash
  git add client/src/design/tokens.ts client/src/index.css client/tailwind.config.js client/index.html client/src/pages/__tests__/tokens.test.ts
  git commit -m "feat(client): design tokens, Tailwind theme and document head"
  ```

---

### Task 2: Client router with legacy room-link compatibility

**Files:**
- Create: `client/src/router.tsx`
- Create: `client/src/pages/__tests__/router.test.tsx`
- Modify: `client/src/main.tsx` — mount the router
- Modify: `client/src/App.tsx` — inside the `phase-5a routing` region only

**Interfaces:**
- Produces: `export type Route = 'landing' | 'create' | 'privacy' | 'terms' | 'security' | 'room';`
- Produces: `export function resolveRoute(pathname: string, search: string): Route;` — pure, testable without a DOM.
- Produces: `export function Router(): JSX.Element;`

**The load-bearing requirement:** every room link ever issued has the shape `/?room=…&token=…` (`src/server/index.ts:173`, `CreateRoom.tsx:29`). Making `/` the marketing landing must not break them. `resolveRoute` therefore checks query parameters **before** it looks at the path.

- [ ] **Step 1: Write the failing test**

  Create `client/src/pages/__tests__/router.test.tsx`:

  ```tsx
  import { describe, expect, it } from 'vitest';
  import { resolveRoute } from '../../router.js';

  describe('resolveRoute', () => {
    it('serves the landing page at the root', () => {
      expect(resolveRoute('/', '')).toBe('landing');
    });

    it('still opens the room for a legacy /?room=&token= link', () => {
      // Every link Nexus has ever issued looks like this. Breaking it would
      // silently strand every room already shared with anyone.
      expect(resolveRoute('/', '?room=room_abc&token=deadbeef')).toBe('room');
    });

    it('opens the room for the new /room path too', () => {
      expect(resolveRoute('/room', '?room=room_abc&token=deadbeef')).toBe('room');
    });

    it('does not treat a half-formed room link as a room', () => {
      expect(resolveRoute('/', '?room=room_abc')).toBe('landing');
      expect(resolveRoute('/', '?token=deadbeef')).toBe('landing');
    });

    it('maps the static pages', () => {
      expect(resolveRoute('/new', '')).toBe('create');
      expect(resolveRoute('/privacy', '')).toBe('privacy');
      expect(resolveRoute('/terms', '')).toBe('terms');
      expect(resolveRoute('/security', '')).toBe('security');
    });

    it('tolerates a trailing slash', () => {
      expect(resolveRoute('/privacy/', '')).toBe('privacy');
    });

    it('falls back to the landing page for an unknown path', () => {
      expect(resolveRoute('/nope', '')).toBe('landing');
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm --prefix client test -- router`
  Expected: FAIL — `client/src/router.tsx` does not exist.

- [ ] **Step 3: Write `client/src/router.tsx`**

  ```tsx
  import { useEffect, useState } from 'react';
  import App from './App.js';
  import { Landing } from './pages/Landing.js';
  import { CreateRoom } from './pages/CreateRoom.js';
  import { Privacy } from './pages/Privacy.js';
  import { Terms } from './pages/Terms.js';
  import { Security } from './pages/Security.js';

  export type Route = 'landing' | 'create' | 'privacy' | 'terms' | 'security' | 'room';

  const PATHS: Record<string, Route> = {
    '/': 'landing',
    '/new': 'create',
    '/privacy': 'privacy',
    '/terms': 'terms',
    '/security': 'security',
    '/room': 'room',
  };

  /**
   * Query parameters are checked BEFORE the path. Room links are "/?room=…&token=…"
   * and always have been; if the root stopped honouring them, every link already
   * shared with anyone would land on a marketing page instead of their session.
   * A room needs both halves — an id alone is not a credential.
   */
  export function resolveRoute(pathname: string, search: string): Route {
    const params = new URLSearchParams(search);
    if (params.get('room') !== null && params.get('token') !== null) return 'room';
    const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
    return PATHS[normalized] ?? 'landing';
  }

  export function Router(): JSX.Element {
    const [route, setRoute] = useState<Route>(() =>
      resolveRoute(globalThis.location.pathname, globalThis.location.search),
    );

    useEffect(() => {
      const onPop = (): void =>
        setRoute(resolveRoute(globalThis.location.pathname, globalThis.location.search));
      globalThis.addEventListener('popstate', onPop);
      return () => globalThis.removeEventListener('popstate', onPop);
    }, []);

    // The room is dark-only; the marketing surfaces honour prefers-color-scheme.
    useEffect(() => {
      document.body.classList.toggle('surface-marketing', route !== 'room');
    }, [route]);

    switch (route) {
      case 'room':
        return <App />;
      case 'create':
        return <CreateRoom onCreated={(link) => globalThis.location.assign(link)} />;
      case 'privacy':
        return <Privacy />;
      case 'terms':
        return <Terms />;
      case 'security':
        return <Security />;
      default:
        return <Landing />;
    }
  }
  ```

- [ ] **Step 4: Point `main.tsx` at the router and strip the branch out of `App.tsx`**

  In `main.tsx`, render `<Router />` instead of `<App />`.

  In `App.tsx`, replace the whole `phase-3c landing-page slot` block (currently lines 51-55) with the new marker region. `App` becomes room-only; the router decides whether to mount it.

  ```tsx
  // --- BEGIN phase-5a routing ---
  // Route selection moved to router.tsx. App is now mounted only for the room
  // route, so a missing room/token here means a malformed link rather than a
  // visitor who has not created a room yet.
  if (params.roomId === '' || params.token === '') {
    return <MalformedLink />;
  }
  // --- END phase-5a routing ---
  ```

  Add `MalformedLink` to `client/src/pages/MalformedLink.tsx` — a short page explaining the link is incomplete, with a link to `/new`. Import it below the `// phase-5a import anchor` line, which you add directly under the existing import block in `App.tsx`.

- [ ] **Step 5: Run tests and commit**

  Run: `npm --prefix client test`, `npm --prefix client run build`
  Expected: all pass. The existing `client/tests/smoke.test.tsx` may need its mount target updated from `App` to `Router` — if so that is expected, and it is inside your ownership.

  ```bash
  git add client/src/router.tsx client/src/main.tsx client/src/App.tsx client/src/pages/MalformedLink.tsx client/src/pages/__tests__/router.test.tsx
  git commit -m "feat(client): route landing, legal and room without breaking legacy links"
  ```

---

### Task 3: Server route allow-list

**Files:**
- Modify: `src/server/index.ts` — the static-route block at lines 169-185 **only**
- Create: `tests/server/static-routes.test.ts`

**The constraint that must survive:** the comment at `src/server/index.ts:169-175` explains that there is deliberately no catch-all, so an unmatched `/api/*` path 404s rather than silently returning `index.html` with a 200. Preserve that property and extend the comment; do not replace it with a wildcard.

- [ ] **Step 1: Write the failing test**

  Create `tests/server/static-routes.test.ts`. Follow the existing harness convention in `tests/server/` for building the app; read a neighbouring test first rather than inventing a setup. Assertions:

  ```ts
  it('serves the SPA shell for every page route', async () => {
    for (const path of ['/', '/new', '/privacy', '/terms', '/security', '/room']) {
      const res = await app.request(path);
      expect(res.status, `${path} should serve the client`).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
    }
  });

  it('still 404s an unmatched API path', async () => {
    // The whole reason there is no catch-all: a typo'd API route must fail
    // loudly instead of returning index.html with a 200.
    const res = await app.request('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
  });

  it('still 404s an unknown non-API path rather than serving the SPA', async () => {
    const res = await app.request('/not-a-page');
    expect(res.status).toBe(404);
  });
  ```

  Set `NEXUS_CLIENT_DIR` to a fixture directory containing a stub `index.html` so the test does not depend on a real Vite build.

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm test -- static-routes`
  Expected: FAIL — `/privacy` currently 404s; only `/` is registered.

- [ ] **Step 3: Replace the static-route block in `src/server/index.ts`**

  ```ts
  // The Docker image copies the Vite bundle to client/dist, but no Phase 1
  // plan owned the wiring between the two: phase-1b owns client/**, phase-1c
  // owns the Dockerfile, and this seam belongs to neither. Registered after
  // the API routes so /healthz and /api/* always win.
  //
  // phase-5a: an explicit allow-list, still NOT a catch-all. Client-side
  // routing needs each page path to return the SPA shell, but a wildcard would
  // swallow unmatched API typos into a 200 and make them very hard to debug.
  // Adding a page means adding it here — that is the intended friction.
  // A room link is "/?room=…&token=…" (and now also "/room?…"); "/" therefore
  // serves the shell either way and the client decides which view to mount.
  const PAGE_ROUTES = ['/', '/new', '/privacy', '/terms', '/security', '/room'] as const;
  const clientDir = process.env['NEXUS_CLIENT_DIR'] ?? 'client/dist';
  app.use('/assets/*', serveStatic({ root: clientDir }));
  for (const path of PAGE_ROUTES) {
    app.get(path, serveStatic({ path: `${clientDir}/index.html` }));
  }
  for (const path of PAGE_ROUTES) {
    app.get(path, (c) =>
      c.text(
        'Nexus server is running, but no client bundle was found. ' +
          'Run `npm --prefix client run build`, or set NEXUS_CLIENT_DIR.',
        503,
      ),
    );
  }
  ```

  Keep the 503 fallback behaviour: when the bundle is missing the operator gets a message naming the fix, not a bare 404.

- [ ] **Step 4: Run tests and commit**

  Run: `npm test`, `npm run typecheck`
  Expected: all pass, both exit 0.

  ```bash
  git add src/server/index.ts tests/server/static-routes.test.ts
  git commit -m "feat(server): serve page routes from an explicit allow-list, not a catch-all"
  ```

---

### Task 4: Landing page

**Files:**
- Create: `client/src/pages/Landing.tsx`
- Create: `client/src/pages/sections/{Hero,Problem,HowItWorks,Governance,Invariants,SecurityHonesty,Status}.tsx`
- Create: `client/src/pages/components/{SiteHeader,SiteFooter,RoomMock}.tsx`
- Create: `client/src/pages/__tests__/landing.test.tsx`

Pattern: **Trust & Authority + Conversion**, from `MASTER.md`. Spacious density (64–96px section padding). Sections in this order:

1. **Hero.** H1: *"One agent. One context window. Everyone in the room."* Sub, from `BUILD_SPEC.md:15-19`: Nexus turns an AI coding session from a process into a room — multiple people open one link, see the same live agent output, take turns driving, and collectively approve or block what the agent is about to do. Nobody re-explains anything. Nobody screen-shares. Primary CTA **Open a room** → `/new`; secondary **How it works** → `#how`. Beside it, `<RoomMock/>`: a **static, non-interactive** markup replica of the room using real tokens. It must not animate or imply live data. Give it `aria-hidden="true"` and a visually-hidden caption naming it a mockup.
2. **Problem.** Three cards: re-explaining context to each teammate's own agent; screen-share latency and one person's hands on the keyboard; no record of who approved the destructive command.
3. **How it works** (`id="how"`). Four steps: paste a Console API key → share the room link → everyone types, the server orders and attributes → the room approves anything destructive.
4. **Governance.** The differentiator, from `BUILD_SPEC.md:246`: *"Collaboration is the mechanism; governance is the product."* Centrepiece is a static replica of the four-eyes approval card. Explain that any participant can decide, the first response wins, and a request nobody answers within 120 seconds is denied — those are the real semantics in `src/server/permissions.ts`.
5. **Invariants.** I1, I2′, I3, I4 as four compact cards, in plain language with the formal statement in mono beneath. Showing the correctness properties is a credibility signal for a developer audience.
6. **Security honesty.** Full-width, `--warn` treatment, `ShieldAlert` icon. Verbatim from `BUILD_SPEC.md:226-228`: **"A shared room is a shared security boundary."** — whatever the room can do, every participant can do: read `.env`, use git credentials, run commands. And **"The MVP has no isolation between rooms."** — one host process, one filesystem. Rooms are invite-only-among-people-you-trust, not public. Link to `/security`.
7. **Status.** Plain statement of what is and is not built, mirroring `README.md:10-12`. If nothing is deployed when this ships, the page says so and the CTA explains it runs locally. **Do not soften this into "coming soon" marketing language.**
8. **Footer** (`SiteFooter`): Privacy · Terms · Security · GitHub. External links carry `rel="noreferrer noopener"`.

- [ ] **Step 1: Write the failing test**

  Create `client/src/pages/__tests__/landing.test.tsx` using `@testing-library/react`, asserting: the security-boundary sentence renders verbatim; the no-isolation sentence renders verbatim; there is exactly one `<h1>`; heading levels never skip; the primary CTA links to `/new`; footer links to `/privacy`, `/terms`, `/security` all exist; and — a regression guard on the honesty rule — the rendered text contains no `trusted by`, no `testimonial`, and no digit-percent pattern that would imply a fabricated metric.

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm --prefix client test -- landing`
  Expected: FAIL — no `Landing` component.

- [ ] **Step 3: Write `SiteHeader` and `SiteFooter`**

  Sticky header (`z-10`), transparent over the hero, gaining `bg-bg/80 backdrop-blur border-b border-border` on scroll. Nav: How it works · Governance · Security · Privacy · **Open a room** (accent CTA). Mobile: a disclosure menu, not a hover dropdown. A skip-to-content link is the first focusable element on the page. Add `pt-` compensation equal to the header height so it never covers the first section.

- [ ] **Step 4: Write the section components and `Landing.tsx`**

  Compose in the order above. Every section is a `<section>` with an `aria-labelledby` pointing at its heading. Reveal-on-scroll (`IntersectionObserver`, opacity + 12px translateY, 250ms) is optional polish — if you add it, elements must be **visible by default** and revealed only when the observer is available, so content never depends on JS to be readable, and it must be skipped entirely under `prefers-reduced-motion`.

- [ ] **Step 5: Run tests and commit**

  Run: `npm --prefix client test`, `npm --prefix client run build`

  ```bash
  git add client/src/pages/Landing.tsx client/src/pages/sections client/src/pages/components client/src/pages/__tests__/landing.test.tsx
  git commit -m "feat(client): landing page with governance and security-honesty sections"
  ```

---

### Task 5: Legal documents

**Files:**
- Create: `client/src/pages/LegalLayout.tsx`
- Create: `client/src/pages/{Privacy,Terms,Security}.tsx`
- Create: `client/src/pages/__tests__/legal.test.tsx`

**Every factual claim below was verified against the code during planning. Re-verify each one before you write it** — read `src/log/redact.ts`, `src/server/rooms.ts`, `src/server/create.ts` and `src/log/event-log.ts`. If any statement no longer matches the implementation, correct the document and note the discrepancy in your report. A privacy policy that has drifted from the code is worse than none.

`LegalLayout`: `max-w-prose` (68ch), 16px body, generous line height, a table of contents for documents over four sections, a "Last updated" date, and a visible link back to `/`.

**`/privacy` must state:**

- **What Nexus is:** self-hostable software plus, if deployed, a hosted instance. Say which one the reader is on.
- **No accounts.** No sign-up, no email, no password, no cookies, no analytics, no third-party trackers, no advertising. The room link is the credential. *(Only claim these if they remain true at ship time — verify before writing.)*
- **Your API key.** Anthropic Console keys (`sk-ant-…`) only. Posted once over HTTPS in a request body, held server-side in memory on the room object, and — verify at `src/server/rooms.ts:52-53` — kept in a `WeakMap` keyed off the room so it is structurally unable to be serialised into the room's JSON or written to the log. Never sent to any client, never placed in a URL, never persisted to the room metadata file. A room recovered after a server restart has no key and refuses connections with close code `4409` until someone re-enters it.
- **Why Console keys only** — quote the policy verbatim: *"Anthropic does not permit third-party developers to offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf of their users."*
- **What is recorded.** `data/rooms/<roomId>.jsonl` is an append-only log holding: room creation (working directory path and repository URL), every join and leave with display name, **the full text of every prompt anyone types**, with the author's participant id and display name, every agent response, every tool call and its result, every permission request and decision with who decided, and every interrupt. Each entry has a sequence number and an ISO timestamp.
- **Redaction is narrow, and say so.** `src/log/redact.ts` replaces `/sk-ant-[A-Za-z0-9_-]+/g` with `[REDACTED]` across every string in every event at the write boundary, and truncates tool output at 4000 characters. It matches **Anthropic API keys and nothing else**. A password, an access token, a customer name or any other secret typed into a prompt is written to the log verbatim. Say this in plain words — it is the disclosure a user is most likely to be harmed by not knowing.
- **Also on disk:** `data/rooms/<roomId>.meta.json` holds the room's own access token in plaintext, alongside the room id, working directory and repository URL.
- **Retention: there is currently no deletion mechanism.** Nexus has no room expiry, no TTL, no delete endpoint, and no export endpoint; Invariant I3 forbids mutating or removing logged events. Logs and cloned repositories persist until an operator deletes them from the server's volume. To have a room's data removed, contact the operator. **This is the single most important sentence in the document — do not bury it in a list.**
- **Stored in your browser:** an identity resume token per room and display name under `nexus:identity:<roomId>:<displayName>` (`client/src/ws.ts:48-50`), and — once `phase-5b` ships its room switcher — a list of recently visited rooms **including their access tokens**. Both are `localStorage`, never transmitted anywhere except back to the Nexus server on reconnect. Warn plainly: on a shared computer, anyone with the browser can open your rooms. Point at the switcher's "Forget this room" control.
- **The room link is the credential.** Anyone with it is a full participant. It appears in browser history, in screenshots and in any chat you paste it into. Nexus sets `referrer: no-referrer` so it is not sent to external sites, but treat it as a password.
- **Repository cloning.** If a repository URL is supplied, the server clones it. URLs containing embedded credentials (`user:pass@host`) are rejected (`src/server/create.ts:99-117`) precisely because such a URL would otherwise be written unredacted into the log.
- **Third parties.** Prompts and code context are sent to Anthropic's API under the room creator's key and are subject to Anthropic's terms and privacy policy — link to them. Nexus adds no other third-party processor.
- A contact route for privacy questions, and a plain "we will update this page and change the date" clause.

**`/terms` must state:** no warranty, provided as-is; you are responsible for what you point the agent at and for everything every participant does in your room; the room creator bears all Anthropic usage costs incurred under their key; Console keys only, per Anthropic's policy; the software is not multi-tenant and must not be represented as isolated; acceptable use (do not use it to attack systems you do not control); the licence this repo ships under; and that the operator may remove rooms or shut down an instance.

**`/security` must state:** the two verbatim `BUILD_SPEC.md` §8 statements as the opening; the threat model in plain terms (in-room participants are trusted, everyone else is not); the four invariants and what each protects; that the token is 256 bits and the room id is only 64 and is not a credential; the four-eyes permission model with its real semantics (anyone decides, first response wins, 120s timeout denies); what is explicitly **not** protected — no room isolation, no sandboxing, no rate limiting on room creation at time of writing, no audit export; and how to report a vulnerability.

- [ ] **Step 1: Write the failing test**

  `client/src/pages/__tests__/legal.test.tsx` asserts, for each of the three pages: it renders, has exactly one `h1`, has a "Last updated" string, and heading levels never skip. Then the content guards that matter — `/privacy` contains the words "no deletion" or "no mechanism to delete", contains "sk-ant", contains "localStorage", and contains the verbatim Anthropic policy sentence; `/security` contains both verbatim `BUILD_SPEC.md` §8 sentences.

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm --prefix client test -- legal`
  Expected: FAIL — the pages do not exist.

- [ ] **Step 3: Write `LegalLayout.tsx`**

- [ ] **Step 4: Write `Privacy.tsx`, `Terms.tsx`, `Security.tsx`**

  Re-read the source files named above as you write each factual claim.

- [ ] **Step 5: Run tests and commit**

  ```bash
  git add client/src/pages/LegalLayout.tsx client/src/pages/Privacy.tsx client/src/pages/Terms.tsx client/src/pages/Security.tsx client/src/pages/__tests__/legal.test.tsx
  git commit -m "docs(client): privacy, terms and security pages derived from the implementation"
  ```

---

### Task 6: Room-creation redesign at `/new`

**Files:**
- Modify: `client/src/pages/CreateRoom.tsx`
- Create: `client/src/pages/__tests__/create-room.test.tsx`

Keep every existing behaviour — the key goes in the body over HTTPS, `setApiKey('')` runs before `onCreated`, and the amber security callout stays. What changes is presentation and the post-creation step.

- Restyle to the token set: `--surface` card on `--bg`, `--warn` security callout, mono key field.
- Strengthen the callout: verbatim security-boundary sentence, `ShieldAlert` icon, plus the no-isolation sentence, plus a link to `/security`.
- Key field: `type="password"`, `autoComplete="off"`, `spellCheck={false}`, a show/hide toggle, and inline validation that the value starts with `sk-ant-` **before** submitting — the server already rejects otherwise (`create.ts:77-89`), but a round-trip to learn about a typo is poor feedback. Helper text keeps the Console-keys-only explanation.
- Repo field: `type="url"`, helper text stating the clone is server-side and that URLs with embedded credentials are rejected.
- Submit: disabled while busy with a spinner and "Creating room…"; never clickable twice.
- **Success is now a step, not a redirect.** Show a success panel with the room link in a mono field, a **Copy link** button that swaps to `Check` + "Copied" for 2s, a warning that the link is the credential and anyone holding it is a full participant, and an **Enter the room** button. Auto-redirecting throws away the one moment the user needs to copy the link.
- Errors render in a `--danger` panel adjacent to the form, with the server's message. Never echo the submitted key into an error.

- [ ] **Step 1: Write the failing test**

  Assert: the key input is `type="password"`; submitting a key not starting with `sk-ant-` shows an inline error and issues **no** fetch; a successful create renders the link and does not navigate automatically; the security-boundary sentence is present; and after success the component's key state is empty (guard on I4 — assert the rendered DOM contains no `sk-ant-` substring).

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm --prefix client test -- create-room`
  Expected: FAIL — current component redirects immediately and has no inline validation.

- [ ] **Step 3: Rewrite `CreateRoom.tsx`**

- [ ] **Step 4: Run tests and commit**

  ```bash
  git add client/src/pages/CreateRoom.tsx client/src/pages/__tests__/create-room.test.tsx
  git commit -m "feat(client): redesign room creation with copy-link confirmation step"
  ```

---

### Task 7: Responsive, accessibility and contrast pass

**Files:** any file already owned by this plan.

- [ ] **Step 1: Responsive sweep at 375 / 768 / 1024 / 1440**

  No horizontal page scroll at any width. Wide content scrolls inside its own `overflow-x:auto` container. Hero display type steps down on mobile. Nav collapses to a disclosure menu. Record what you changed.

- [ ] **Step 2: Keyboard and screen-reader sweep**

  Tab through every page: focus visible everywhere, order matches visual order, no traps, skip link works, the mobile menu traps focus while open and returns it on close. Every icon-only control has an `aria-label`. Every image has `alt` (or `alt=""` if decorative).

- [ ] **Step 3: Measured contrast audit**

  Check every text/background pair with a contrast tool in **both** colour schemes. ≥4.5:1 body, ≥3:1 large text. Paste the measured table into your report. Pay attention to `--danger` on `--surface-2` and to every accent-on-white pair in light mode — those are the two known-tight cases.

- [ ] **Step 4: Reduced-motion check**

  With `prefers-reduced-motion: reduce`, every page is fully readable and no information is lost.

- [ ] **Step 5: Commit**

  ```bash
  git add client/src
  git commit -m "fix(client): responsive, contrast and keyboard-accessibility pass on marketing pages"
  ```

---

### Task 8: README pointer and deploy warning

**Files:**
- Modify: `README.md` — **only** if `phase-5b` is not concurrently editing it; otherwise report `BLOCKED` and put the text in your report instead.

- [ ] **Step 1: Add a Website section**

  Name the routes (`/`, `/new`, `/privacy`, `/terms`, `/security`) and state that they are served by the same process from `client/dist`.

- [ ] **Step 2: Add the deploy warning**

  Verbatim intent: *the marketing site must not be exposed publicly until `POST /api/rooms` is hardened.* It currently requires no credential and drives an outbound `git clone` against any host passing a scheme-and-charset check; a landing page inviting strangers to click "Open a room" turns that from a latent issue into an exposed one. Cross-reference the newest `sessions/` `issues.md` §B.

- [ ] **Step 3: Commit**

  ```bash
  git add README.md
  git commit -m "docs: point README at the website routes and gate the public deploy on API hardening"
  ```

---

## Report notes

Confirm each with pasted evidence, not assertion:

- [ ] `npm test`, `npm run test:client`, `npm run typecheck`, `npm --prefix client run build` — all four exit 0. Paste the tail of each.
- [ ] **Legacy link works.** Paste the `resolveRoute` test output *and* confirm manually: start the server on `PORT=8099` and open a real `/?room=…&token=…` link — the room mounts, not the landing page.
- [ ] **`/api/*` still 404s.** Paste the status and body of `GET /api/definitely-not-a-route`.
- [ ] **Every page route returns HTML** with a real bundle present, and returns the 503-with-instructions message when `NEXUS_CLIENT_DIR` points somewhere empty.
- [ ] **Measured contrast table** for both colour schemes, with the tool named.
- [ ] **Privacy-doc accuracy statement.** List each factual claim in `/privacy` and the file and line you verified it against. Flag anything that no longer matches.
- [ ] **Honesty check.** Confirm there is no fabricated social proof, metric, testimonial, logo or capability claim anywhere in the rendered site.
- [ ] **Screenshots** at 375px and 1440px of the landing page and `/privacy`, in both colour schemes.
- [ ] Note any token you needed that `design-system/nexus/MASTER.md` does not define.
