import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';

export interface LegalSection {
  id: string;
  heading: string;
}

/**
 * Shared shell for /privacy, /terms and /security. 68ch measure and a 16px
 * floor per design-system/nexus/MASTER.md §2 — "a privacy policy nobody can
 * read is a dark pattern regardless of intent."
 */
export function LegalLayout({
  title,
  lastUpdated,
  sections,
  children,
}: {
  title: string;
  lastUpdated: string;
  /** Rendered as a table of contents when there are more than four. */
  sections?: LegalSection[];
  children: ReactNode;
}): JSX.Element {
  const showToc = (sections?.length ?? 0) > 4;

  return (
    <main className="mx-auto max-w-prose px-4 py-16 text-base leading-relaxed text-fg sm:px-6">
      <a
        href="/"
        className="inline-flex min-h-[44px] items-center gap-2 rounded text-sm text-fg-muted transition-colors duration-150 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <ArrowLeft size={16} aria-hidden="true" />
        Back to Nexus
      </a>

      <h1 className="mt-6 text-3xl font-semibold text-fg">{title}</h1>
      <p className="mt-2 text-sm text-fg-muted">Last updated: {lastUpdated}</p>

      {showToc && sections !== undefined && (
        <nav aria-label="Table of contents" className="mt-8 rounded-lg border border-border bg-surface p-4">
          <p className="mb-2 text-sm font-semibold text-fg">Contents</p>
          <ol className="flex flex-col gap-1 text-sm">
            {sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="rounded text-info transition-colors duration-150 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                >
                  {section.heading}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      )}

      <div className="mt-8 flex flex-col gap-8">{children}</div>
    </main>
  );
}
