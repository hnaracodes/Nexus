const GITHUB_URL = 'https://github.com';

/**
 * Footer links to the legal pages (owned by another task at these routes)
 * and to GitHub. External links carry rel="noreferrer noopener".
 */
export function SiteFooter(): JSX.Element {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-12 text-sm text-fg-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>Nexus — one agent, one context window, everyone in the room.</p>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
          <a href="/privacy" className="hover:text-fg">
            Privacy
          </a>
          <a href="/terms" className="hover:text-fg">
            Terms
          </a>
          <a href="/security" className="hover:text-fg">
            Security
          </a>
          <a
            href={GITHUB_URL}
            rel="noreferrer noopener"
            target="_blank"
            className="hover:text-fg"
          >
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
