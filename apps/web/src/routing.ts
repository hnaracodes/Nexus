/**
 * Pure route-resolution logic, deliberately free of any React or page import.
 * router.tsx re-exports this so `Route`/`resolveRoute` are still reachable
 * from `./router.js`, but keeping the logic here means it can be tested (and
 * used) without pulling in the whole page module graph — several of those
 * pages are owned and built by sibling agents landing concurrently.
 */

export type Route =
  | 'landing'
  | 'create'
  | 'privacy'
  | 'terms'
  | 'security'
  | 'room'
  | 'configs'
  | 'download'
  | 'usage';

/**
 * Exported (not just module-private) so a test can assert every path here is
 * also in `@nexus/protocol/pages`'s `PAGE_PATHS` — the allow-list the server
 * actually serves. `/download` shipped resolving here while missing from
 * that list, which 404'd in production and passed in development because
 * vite's dev server is a catch-all and the deployed server deliberately is
 * not. That failure mode is per-path, not one-shot, so the guard has to be
 * "every path", not "the one path that broke last time".
 */
export const PATHS: Record<string, Route> = {
  '/': 'landing',
  '/new': 'create',
  '/privacy': 'privacy',
  '/terms': 'terms',
  '/security': 'security',
  '/configs': 'configs',
  '/room': 'room',
  '/download': 'download',
  '/usage': 'usage',
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
