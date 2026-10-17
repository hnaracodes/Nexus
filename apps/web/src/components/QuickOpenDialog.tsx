import { useEffect, useRef, useState } from 'react';
import { useFileIndex } from '../workspace/useFileIndex.js';
import type { WorkspaceApi } from '../workspace/workspaceApi.js';

/**
 * `⌘P` quick-open as a VS Code quick-pick: top-centered, types a substring,
 * picks a file, it opens as a tab. The tree walk is shared with the Search view
 * (`useFileIndex`) and capped there.
 */
export function QuickOpenDialog({
  open,
  api,
  onOpen,
  onClose,
}: {
  open: boolean;
  api: WorkspaceApi;
  onOpen: (path: string) => void;
  onClose: () => void;
}): JSX.Element | null {
  const [query, setQuery] = useState('');
  const allFiles = useFileIndex(api, open);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return undefined;
    }
    const focusId = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(focusId);
  }, [open]);

  if (!open) return null;

  const matches =
    allFiles === null
      ? []
      : allFiles.filter((path) => path.toLowerCase().includes(query.toLowerCase())).slice(0, 50);

  function pick(path: string): void {
    onOpen(path);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Go to file"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === 'Enter' && matches[0] !== undefined) {
            event.preventDefault();
            pick(matches[0]);
          }
        }}
        className="w-full max-w-xl overflow-hidden rounded border border-border bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
      >
        <div className="p-1">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Go to file…"
            aria-label="Go to file"
            className="h-7 w-full rounded-sm border border-border-strong bg-input px-2 text-[13px] text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          />
        </div>
        <ul className="max-h-72 overflow-y-auto pb-1">
          {allFiles === null && <li className="px-3 py-2 text-xs text-fg-muted">Loading files…</li>}
          {allFiles !== null && matches.length === 0 && (
            <li className="px-3 py-2 text-xs text-fg-muted">No matching files.</li>
          )}
          {matches.map((path) => (
            <li key={path}>
              <button
                type="button"
                onClick={() => pick(path)}
                className="flex min-h-[22px] w-full items-center px-3 py-0.5 text-left font-mono text-xs text-fg hover:bg-surface-2 focus-visible:bg-accent-dim focus-visible:outline-none"
              >
                {path}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
