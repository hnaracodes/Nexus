import { useEffect, useRef, useState } from 'react';
import { File as FileIcon } from 'lucide-react';
import { useFileIndex } from '../workspace/useFileIndex.js';
import type { WorkspaceApi } from '../workspace/workspaceApi.js';

const MAX_SHOWN = 200;

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

/**
 * Side bar > Search: a FILENAME filter over the same capped tree walk quick-open
 * uses. Deliberately not content search — that needs a server route this unit
 * does not own — and it says so, rather than implying a grep that is not there.
 */
export function SearchView({
  api,
  onSelectFile,
  focusNonce,
}: {
  api: WorkspaceApi;
  onSelectFile: (path: string) => void;
  /** Bumped by the shell (Cmd/Ctrl+Shift+F) to pull focus into the box. */
  focusNonce: number;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const files = useFileIndex(api, true);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusNonce]);

  const needle = query.trim().toLowerCase();
  const matches =
    files === null || needle === '' ? [] : files.filter((p) => p.toLowerCase().includes(needle));

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="shrink-0 p-2">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search file names"
          aria-label="Search file names"
          className="h-7 w-full rounded-sm border border-border-strong bg-input px-2 text-[13px] text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {files === null && <p className="px-3 py-1 text-xs text-fg-muted">Indexing files…</p>}
        {files !== null && needle === '' && (
          <p className="px-3 py-1 text-xs text-fg-muted">Type to filter by file name. Contents are not searched.</p>
        )}
        {files !== null && needle !== '' && matches.length === 0 && (
          <p className="px-3 py-1 text-xs text-fg-muted">No matching files.</p>
        )}
        <ul aria-label="Search results">
          {matches.slice(0, MAX_SHOWN).map((path) => (
            <li key={path}>
              <button
                type="button"
                onClick={() => onSelectFile(path)}
                title={path}
                className="flex min-h-[24px] w-full items-center gap-1.5 px-3 py-0.5 text-left text-[13px] text-fg hover:bg-surface-2 focus-visible:bg-accent-dim focus-visible:outline-none"
              >
                <FileIcon size={14} className="shrink-0 text-fg-muted" aria-hidden="true" />
                <span className="shrink-0">{basename(path)}</span>
                <span className="truncate text-xs text-fg-muted">{dirname(path)}</span>
              </button>
            </li>
          ))}
        </ul>
        {matches.length > MAX_SHOWN && (
          <p className="px-3 py-1 text-xs text-fg-muted">Showing the first {MAX_SHOWN} of {matches.length} matches.</p>
        )}
      </div>
    </div>
  );
}
