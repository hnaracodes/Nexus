/**
 * Every path the web app serves as a PAGE, in one place, because it was in two
 * and they drifted.
 *
 * Adding a route used to be three edits in three packages: `resolveRoute` in
 * `apps/web/src/routing.ts` (does this path mean a page?), the dispatch switch
 * in `apps/web/src/router.tsx` (which component?), and `PAGE_ROUTES` in
 * `apps/server/src/server/index.ts` (does the server hand back index.html?).
 * Miss the second and the wrong page renders with a 200. Miss the third and the
 * URL 404s in production while working perfectly in development, because vite's
 * dev server IS a catch-all and the deployed server deliberately is not.
 *
 * `/download` shipped having missed both. It resolved, it rendered Landing, and
 * once that was fixed it still 404'd on the live site.
 *
 * So the list lives here, beside `docsync.ts`, which exists for exactly the same
 * reason: a format defined twice is a format that will drift. The server builds
 * its allow-list from this; a test in the web app asserts `resolveRoute` knows
 * every entry. Neither can quietly fall behind the other.
 *
 * NOT a catch-all, and must never become one: an unmatched `/api/*` has to keep
 * returning 404 rather than 200 with an HTML body, which is what sends a client
 * off to parse `<!doctype html>` as JSON.
 */
export const PAGE_PATHS = [
  '/',
  '/new',
  '/room',
  '/configs',
  '/download',
  '/usage',
  '/privacy',
  '/terms',
  '/security',
] as const;

export type PagePath = (typeof PAGE_PATHS)[number];
