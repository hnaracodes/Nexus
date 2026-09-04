import { useEffect, useRef } from 'react';
import { AlertTriangle, Binary, FileWarning, Loader2, RefreshCw } from 'lucide-react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import type { CachedFile } from '../workspace/useWorkspace.js';
import { loadLanguage } from '../workspace/cmLanguage.js';
import { nexusEditorTheme, nexusHighlightStyle } from '../workspace/cmTheme.js';

export interface CodeEditorProps {
  path: string | null;
  /** `undefined` means "not yet requested" — distinct from `loading`. */
  cached: CachedFile | undefined;
  onRefresh: (path: string) => void;
}

/**
 * The file pane, rendered by CodeMirror 6 (phase 11a).
 *
 * Deliberately a DROP-IN for the `CodeViewer` it replaced (deleted in the same
 * phase): identical props, identical handling
 * of every non-text cache state. Only the text rendering changed. Swapping the
 * rendering engine is the largest visible change in phase 11, and doing it while
 * behaviour is otherwise frozen means any regression belongs unambiguously to
 * the swap rather than to the CRDT work that follows it.
 *
 * Still read-only, and that is enforced twice on purpose. CodeMirror is editable
 * by DEFAULT, so shipping this without `EditorView.editable.of(false)` would
 * produce a box that accepts keystrokes, discards them on the next re-render and
 * writes them nowhere — indistinguishable from data loss to the person typing.
 * `EditorState.readOnly` additionally tells commands and extensions that the
 * document is not writable, which is what keeps later extensions honest. Both
 * come off together in 11b, behind the Automerge document.
 */
export function CodeEditor({ path, cached, onRefresh }: CodeEditorProps): JSX.Element {
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
          <CodeMirrorSurface path={path} content={cached.result.content} />
        )}
      </div>
    </div>
  );
}

/**
 * The CodeMirror instance itself. A view is created ONCE and then mutated,
 * which is CodeMirror's intended lifecycle rather than an optimisation:
 * recreating it per render would discard scroll position and selection on every
 * keystroke once 11b lands, and would drop remote participants' cursors in 11c.
 */
function CodeMirrorSurface({ path, content }: { path: string; content: string }): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  /**
   * Held in a ref rather than module scope: a compartment identifies a slot in
   * ONE view's configuration, so a shared one would make two open files
   * reconfigure each other's language.
   */
  const language = useRef(new Compartment());
  /** The doc the view is built with. Later content arrives by transaction. */
  const initial = useRef(content);

  useEffect(() => {
    if (host.current === null) return undefined;
    const instance = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          lineNumbers(),
          syntaxHighlighting(nexusHighlightStyle, { fallback: true }),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          language.current.of([]),
          nexusEditorTheme,
        ],
      }),
    });
    view.current = instance;
    return () => {
      instance.destroy();
      view.current = null;
    };
  }, []);

  // Content changes — including switching to a different file — replace the
  // document in place rather than rebuilding the view.
  useEffect(() => {
    const instance = view.current;
    if (instance === null || instance.state.doc.toString() === content) return;
    instance.dispatch({ changes: { from: 0, to: instance.state.doc.length, insert: content } });
  }, [content]);

  // Grammar arrives asynchronously and reconfigures in place, so text is never
  // blocked on a language pack — the same contract `highlighter.ts` had.
  useEffect(() => {
    let cancelled = false;
    void loadLanguage(path).then((extension) => {
      const instance = view.current;
      if (cancelled || instance === null) return;
      instance.dispatch({ effects: language.current.reconfigure(extension ?? []) });
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return <div ref={host} className="h-full font-mono text-[13px]" data-testid="code-editor" />;
}
