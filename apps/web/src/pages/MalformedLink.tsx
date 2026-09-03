import { AlertOctagon } from 'lucide-react';

/**
 * Rendered by App when the room route is reached without both a room id and
 * a token in the query string. Under the router (phase-5a), that only
 * happens for a genuinely incomplete link, never for "no room created yet" —
 * that case is now the landing page at `/`.
 */
export function MalformedLink(): JSX.Element {
  return (
    <main className="mx-auto flex min-h-screen max-w-prose flex-col items-center justify-center gap-4 p-8 text-center">
      <AlertOctagon size={20} strokeWidth={2} className="text-danger" aria-hidden="true" />
      <h1 className="text-2xl font-semibold text-fg">This room link is incomplete</h1>
      <p className="text-fg-muted">
        A Nexus room link needs both a room id and an access token. This one is missing at least
        one of them, so there is no room to join.
      </p>
      <a
        href="/new"
        className="mt-2 inline-flex min-h-11 items-center justify-center rounded px-4 py-2 font-medium text-bg bg-accent transition-colors duration-150 ease-out hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        Open a new room
      </a>
    </main>
  );
}
