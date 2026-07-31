import { useEffect, useState } from 'react';
import App from './App.js';
import { Landing } from './pages/Landing.js';
import { CreateRoom } from './pages/CreateRoom.js';
import { Privacy } from './pages/Privacy.js';
import { Terms } from './pages/Terms.js';
import { Security } from './pages/Security.js';
import { resolveRoute } from './routing.js';
import type { Route } from './routing.js';

// Re-exported so `./router.js` remains the documented entry point for both
// names, even though the logic itself lives in `./routing.js` (see that file
// for why: it lets resolveRoute be tested without the page module graph).
export { resolveRoute } from './routing.js';
export type { Route } from './routing.js';

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
