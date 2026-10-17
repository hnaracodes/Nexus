import { ChevronRight } from 'lucide-react';

/**
 * The path of the open file as VS Code breadcrumbs: one segment per directory,
 * the last being the file. A root-level file has a single segment. Not
 * interactive — the Explorer already navigates; this orients.
 */
export function Breadcrumbs({ path }: { path: string }): JSX.Element {
  const segments = path.split('/').filter((segment) => segment !== '');
  return (
    <nav
      aria-label="Breadcrumbs"
      className="flex h-[22px] shrink-0 items-center gap-0.5 overflow-hidden whitespace-nowrap bg-bg px-3 text-xs text-fg-muted"
    >
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        return (
          <span key={`${index}:${segment}`} className="flex min-w-0 items-center gap-0.5">
            {index > 0 && <ChevronRight size={12} className="shrink-0" aria-hidden="true" />}
            <span
              data-breadcrumb-segment=""
              {...(isLast ? { 'aria-current': 'page' as const } : {})}
              className={`truncate ${isLast ? 'text-fg' : ''}`}
            >
              {segment}
            </span>
          </span>
        );
      })}
    </nav>
  );
}
