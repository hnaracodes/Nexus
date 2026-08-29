import { useEffect, useState } from 'react';
import { AlertTriangle, Binary, FileWarning, Loader2, RefreshCw } from 'lucide-react';
import type { CachedFile } from '../workspace/useWorkspace.js';
import type { HighlightedLine } from '../workspace/highlighter.js';

export interface CodeViewerProps {
  path: string | null;
  /** `undefined` means "not yet requested" — distinct from `loading`. */
  cached: CachedFile | undefined;
  onRefresh: (path: string) => void;
}

/**
 * Renders all four cache states distinctly so the viewer never renders
 * "still fetching" as "empty file." Line numbers always render; Shiki
 * highlighting is loaded lazily (a dynamic `import()` of `highlighter.ts`,
 * never a static one — see that module's own comment) and layers on top of
 * the plain text once it resolves, so content is never blocked on Shiki.
 */
export function CodeViewer({ path, cached, onRefresh }: CodeViewerProps): JSX.Element {
  const [highlighted, setHighlighted] = useState<HighlightedLine[] | null>(null);

  const content =
    cached !== undefined &&
    (cached.status === 'ready' || cached.status === 'stale') &&
    cached.result.kind === 'text'
      ? cached.result.content
      : null;

  useEffect(() => {
    setHighlighted(null);
    if (path === null || content === null) return undefined;
    let cancelled = false;
    void import('../workspace/highlighter.js').then(({ highlightCode }) =>
      highlightCode(path, content).then((lines) => {
        if (!cancelled) setHighlighted(lines);
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [path, content]);

  if (path === null) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-fg-muted">
        Select a file to view its contents.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 text-xs">
        <span aria-label="Current file" className="truncate font-mono text-fg">
          {path}
        </span>
        {cached?.status === 'stale' && (
          <button
            type="button"
            onClick={() => onRefresh(path)}
            className="ml-auto flex min-h-[28px] items-center gap-1 rounded border border-warn px-2 py-0.5 text-warn focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
          >
            <RefreshCw size={12} aria-hidden="true" />
            Content changed — refresh
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {cached === undefined || cached.status === 'loading' ? (
          <div className="flex items-center gap-2 p-4 text-sm text-fg-muted">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            Loading…
          </div>
        ) : cached.status === 'error' ? (
          <div className="flex items-center gap-2 p-4 text-sm text-danger">
            <AlertTriangle size={16} aria-hidden="true" />
            {cached.message}
          </div>
        ) : cached.result.kind === 'binary' ? (
          <div className="flex items-center gap-2 p-4 text-sm text-fg-muted">
            <Binary size={16} aria-hidden="true" />
            Binary file — no preview available.
          </div>
        ) : cached.result.kind === 'too_large' ? (
          <div className="flex items-center gap-2 p-4 text-sm text-fg-muted">
            <FileWarning size={16} aria-hidden="true" />
            File is {cached.result.size.toLocaleString()} bytes — too large to preview.
          </div>
        ) : (
          <CodeLines content={cached.result.content} highlighted={highlighted} />
        )}
      </div>
    </div>
  );
}

function CodeLines({
  content,
  highlighted,
}: {
  content: string;
  highlighted: HighlightedLine[] | null;
}): JSX.Element {
  const rawLines = content.split('\n');
  return (
    <pre className="min-w-full font-mono text-[13px] leading-5">
      <code>
        {rawLines.map((line, i) => {
          const tokens = highlighted?.[i]?.tokens;
          return (
            <div key={i} className="flex min-h-[20px]">
              <span className="w-12 shrink-0 select-none border-r border-border px-2 text-right text-fg-muted">
                {i + 1}
              </span>
              <span className="flex-1 whitespace-pre px-2 text-fg">
                {tokens !== undefined
                  ? tokens.map((token, ti) => (
                      <span key={ti} style={token.color !== null ? { color: token.color } : undefined}>
                        {token.text}
                      </span>
                    ))
                  : line}
              </span>
            </div>
          );
        })}
      </code>
    </pre>
  );
}
