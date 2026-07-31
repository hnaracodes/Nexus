import { Notice } from './Notice.js';
import type { NoticeProps } from './Notice.js';

export interface StackedNotice extends NoticeProps {
  id: string;
}

/**
 * z-30 per design-system/nexus/MASTER.md §3. Top-right on desktop, full-width
 * top on mobile. The outer wrapper is pointer-events-none so it never blocks
 * clicks on the page beneath the gaps between notices; each notice re-enables
 * pointer events for itself.
 */
export function NoticeStack({ notices }: { notices: StackedNotice[] }): JSX.Element | null {
  if (notices.length === 0) return null;

  return (
    <div
      aria-label="Notifications"
      className="pointer-events-none fixed inset-x-0 top-0 z-30 flex flex-col items-stretch gap-2 p-2 sm:inset-x-auto sm:right-2 sm:top-2 sm:w-96 sm:items-end"
    >
      {notices.map(({ id, ...notice }) => (
        <div key={id} className="pointer-events-auto w-full">
          <Notice {...notice} />
        </div>
      ))}
    </div>
  );
}
