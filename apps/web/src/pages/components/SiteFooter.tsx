// lucide-react dropped brand icons, so there is no Github glyph; ExternalLink
// is what this link actually is.
import { ExternalLink } from 'lucide-react';

const GITHUB_URL = 'https://github.com';

const COLUMNS = [
  {
    heading: 'Product',
    links: [
      { label: 'Open a room', href: '/new' },
      { label: 'How it works', href: '/#how' },
      { label: 'Governance', href: '/#governance' },
    ],
  },
  {
    heading: 'Trust',
    links: [
      { label: 'Security model', href: '/security' },
      { label: 'Privacy', href: '/privacy' },
      { label: 'Terms', href: '/terms' },
    ],
  },
] as const;

/**
 * Site footer. External links carry rel="noreferrer noopener" — and the room
 * token lives in a query string, so index.html also sets referrer=no-referrer.
 */
export function SiteFooter(): JSX.Element {
  return (
    <footer className="relative mt-8 border-t border-border bg-surface/40">
      {/* Gradient hairline — ties the footer to the hero's accent without weight. */}
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent"
      />

      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <a
              href="/"
              className="inline-flex items-center gap-2 font-mono text-lg font-semibold tracking-tight text-fg transition-colors duration-150 hover:text-accent"
            >
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-accent" />
              syncode
            </a>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-fg-muted">
              One agent, one context window, everyone in the room. Take turns driving, and approve
              what the agent does before it does it.
            </p>
            <a
              href={GITHUB_URL}
              rel="noreferrer noopener"
              target="_blank"
              className="mt-6 inline-flex min-h-[44px] items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium text-fg transition-colors duration-150 hover:border-accent/50 hover:bg-surface"
            >
              <ExternalLink size={16} aria-hidden="true" />
              View on GitHub
            </a>
          </div>

          {COLUMNS.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <h2 className="text-sm font-semibold text-fg">{column.heading}</h2>
              <ul className="mt-4 space-y-3">
                {column.links.map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      className="inline-block text-sm text-fg-muted transition-colors duration-150 hover:text-accent"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-14 flex flex-col gap-4 border-t border-border pt-8 text-sm text-fg-muted sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} SynCode. Bring your own Anthropic Console key.</p>
          <p>Built for teams who want a record of who approved what.</p>
        </div>
      </div>
    </footer>
  );
}
