import { useEffect, useRef } from 'react';
import { ExternalLink, GitPullRequest } from 'lucide-react';
import type { PublishedPr } from '../publishedPr.js';

export interface PublishedPrCardProps {
  pr: PublishedPr | null;
  selfId: string | null;
  /** True while the socket is still replaying history (see `RoomView`). */
  replaying: boolean;
  /** Injectable for tests; defaults to a hardened `window.open`. */
  openWindow?: (url: string) => Window | null;
}

/**
 * `noopener` matters beyond hygiene here: without it the opened tab gets a
 * `window.opener` handle back to a page whose URL carries the room token.
 * `noreferrer` keeps that same token out of the `Referer` GitHub would see.
 */
function defaultOpenWindow(url: string): Window | null {
  return globalThis.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * The room's pull request, shown as a card and — for the one participant who
 * approved it — opened automatically.
 *
 * Auto-open is best-effort by construction. A `github_published` event arrives
 * over a WebSocket, which is not user activation, so a popup blocker is
 * entitled to refuse it and commonly does. The card is therefore never a
 * consolation prize for a blocked popup; it always renders, and the popup is
 * the bonus. Anything that made the card conditional on the popup failing
 * would strand a blocked user with no way to reach their PR.
 */
export function PublishedPrCard({
  pr,
  selfId,
  replaying,
  openWindow = defaultOpenWindow,
}: PublishedPrCardProps): JSX.Element | null {
  // Keyed by seq, not by a boolean: a second publish is a genuinely new PR
  // state and should open again, while a re-render of the same one must not.
  const openedSeq = useRef<number | null>(null);

  useEffect(() => {
    if (pr === null || replaying) return;
    // Only the approver. Everyone else in the room is reading along and would
    // lose focus to a tab they did not ask for.
    if (selfId === null || pr.approvedBy !== selfId) return;
    if (openedSeq.current === pr.seq) return;
    openedSeq.current = pr.seq;
    openWindow(pr.prUrl);
  }, [pr, selfId, replaying, openWindow]);

  if (pr === null) return null;

  return (
    <div className="mx-4 my-2 rounded border border-accent/40 bg-surface-2 p-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-fg">
        <GitPullRequest size={16} className="text-accent" aria-hidden="true" />
        <span>
          {pr.created ? 'Opened' : 'Updated'} pull request #{pr.prNumber}
        </span>
      </div>
      <p className="mt-1 text-xs text-fg-muted">
        {pr.filesChanged} file{pr.filesChanged === 1 ? '' : 's'} changed on branch{' '}
        <code className="font-mono">{pr.branch}</code>
      </p>
      <a
        href={pr.prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 rounded bg-accent px-3 text-sm font-semibold text-bg hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        Open pull request #{pr.prNumber}
        <ExternalLink size={14} aria-hidden="true" />
      </a>
    </div>
  );
}
