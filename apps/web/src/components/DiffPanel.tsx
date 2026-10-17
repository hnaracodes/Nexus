import { useEffect, useState } from 'react';
import type { WorkspaceApi } from '../workspace/workspaceApi.js';

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; diff: string };

type LineKind = 'add' | 'remove' | 'hunk' | 'meta' | 'context';

function classify(line: string): LineKind {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
    return 'meta';
  }
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

// Same tints `DiffViewer` uses for the same meaning (added / removed lines).
const TINT: Record<LineKind, string> = {
  add: 'bg-accent-dim/40',
  remove: 'bg-danger/10',
  hunk: 'text-info',
  meta: 'text-fg-muted',
  context: '',
};

/**
 * Panel > DIFF: the working-tree diff (`git diff`) of one changed file, as a
 * plain unified diff. Revealed when a file is clicked in Source Control.
 * Colour never carries the meaning alone — added and removed lines keep their
 * `+` / `-` prefix.
 */
export function DiffPanel({ api, path }: { api: WorkspaceApi; path: string | null }): JSX.Element {
  const [state, setState] = useState<State>({ status: 'idle' });

  useEffect(() => {
    if (path === null) {
      setState({ status: 'idle' });
      return undefined;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    api
      .getGitDiff(path)
      .then((result) => {
        if (!cancelled) setState({ status: 'ready', diff: result.diff });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: error instanceof Error ? error.message : 'Failed to load the diff.' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, path]);

  if (path === null || state.status === 'idle') {
    return <p className="p-3 text-xs text-fg-muted">Select a changed file in Source Control to see its diff.</p>;
  }
  if (state.status === 'loading') return <p className="p-3 text-xs text-fg-muted">Loading diff…</p>;
  if (state.status === 'error') return <p className="p-3 text-xs text-danger">{state.message}</p>;
  if (state.diff.trim() === '') {
    return <p className="p-3 text-xs text-fg-muted">No uncommitted changes in {path}.</p>;
  }

  const lines = state.diff.replace(/\n$/, '').split('\n');
  return (
    <pre aria-label={`Diff of ${path}`} className="min-h-0 flex-1 overflow-auto py-1 font-mono text-xs">
      {lines.map((line, index) => (
        <div key={index} className={`whitespace-pre px-4 ${TINT[classify(line)]}`}>
          {line === '' ? ' ' : line}
        </div>
      ))}
    </pre>
  );
}
