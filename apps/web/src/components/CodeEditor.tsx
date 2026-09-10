import { useEffect, useRef } from 'react';
import { AlertTriangle, Binary, FileWarning, Loader2, RefreshCw } from 'lucide-react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import type { CachedFile } from '../workspace/useWorkspace.js';
import { loadLanguage } from '../workspace/cmLanguage.js';
import { nexusEditorTheme, nexusHighlightStyle } from '../workspace/cmTheme.js';
import { collabExtension } from '../workspace/cmCollab.js';
import type { DocSession } from '../workspace/docSession.js';

export interface CodeEditorProps {
  path: string | null;
  /** `undefined` means "not yet requested" — distinct from `loading`. */
  cached: CachedFile | undefined;
  onRefresh: (path: string) => void;
  /**
   * Present once the room's collaborative layer is wired up (phase 11b+).
   * `undefined` for every caller that hasn't wired it in yet — including
   * every `WorkspacePane` render as of this phase — in which case the pane
   * stays exactly as read-only as 11a. This alone is the writability gate;
   * `path` is already guaranteed non-null wherever it matters (the
   * `path === null` branch above returns before `CodeMirrorSurface` is ever
   * reached).
   */
  docSession?: DocSession;
  /**
   * This client's own participant id. Used only inside `cmCollab.ts` to keep
   * the remote-cursor decoration layer from drawing a "remote" caret over
   * your own — cosmetic, not a gate. Omitting it while `docSession` is
   * present still edits correctly; it just also decorates your own cursor as
   * if it belonged to a peer.
   */
  selfId?: string;
}

/**
 * The file pane, rendered by CodeMirror 6 (phase 11a: read-only; 11b:
 * writable + collaborative once a `DocSession` is supplied).
 *
 * Deliberately a DROP-IN for the `CodeViewer` it replaced (deleted in phase
 * 11a): identical props, identical handling of every non-text cache state.
 * Only the text rendering changed there. This phase adds exactly two new
 * OPTIONAL props on top, so every existing caller keeps 11a's frozen,
 * read-only behaviour without touching a line.
 *
 * Read-only is enforced twice on purpose when there is no `DocSession`.
 * CodeMirror is editable by DEFAULT, so shipping this without
 * `EditorView.editable.of(false)` would produce a box that accepts
 * keystrokes, discards them on the next re-render and writes them nowhere —
 * indistinguishable from data loss to the person typing. `EditorState.readOnly`
 * additionally tells commands and extensions that the document is not
 * writable, which is what keeps later extensions honest. Both flip together,
 * gated on the same condition, so there is no state where one says writable
 * and the other doesn't.
 */
export function CodeEditor({ path, cached, onRefresh, docSession, selfId }: CodeEditorProps): JSX.Element {
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
          // Keyed by path, so each file gets its OWN editor instance and its own
          // lifecycle. Without this React reuses one instance across a file switch
          // and the create-once effect never re-runs — harmless while read-only,
          // but in 11b the surviving instance would still hold the previous file's
          // Automerge document and splice this file's keystrokes into it.
          <CodeMirrorSurface
            key={path}
            path={path}
            content={cached.result.content}
            docSession={docSession}
            selfId={selfId}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The CodeMirror instance itself. A view is created once PER FILE and then
 * mutated within that file, which is CodeMirror's intended lifecycle rather than
 * an optimisation: recreating it on every render would discard scroll position
 * and selection on each keystroke, and would drop remote participants' cursors
 * (their decorations live in `cmCollab.ts`'s own plugin state, keyed to this
 * view instance).
 *
 * Per file, not per mount, is the important half — see the `key` at the call
 * site. `docSession`/`selfId` are captured once, in a ref, at construction
 * time alongside `content` — like `content`, they belong to the file this
 * instance was built for; a real change in either implies a different
 * collaborative document, which is exactly what the `key={path}` remount is
 * already for.
 */
function CodeMirrorSurface({
  path,
  content,
  docSession,
  selfId,
}: {
  path: string;
  content: string;
  docSession?: DocSession;
  selfId?: string;
}): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  /**
   * Held in a ref rather than module scope: a compartment identifies a slot in
   * ONE view's configuration, so a shared one would make two open files
   * reconfigure each other's language.
   */
  const language = useRef(new Compartment());
  /** The doc the view is built with. Later content arrives by transaction —
   *  or, once collaborative, by `cmCollab.ts` applying the CRDT's own text. */
  const initial = useRef(content);
  const collab = useRef({ docSession, selfId });
  /** Gates BOTH `EditorState.readOnly` and `EditorView.editable` below —
   *  see `CodeEditor`'s doc comment on why they must never disagree. */
  const writable = collab.current.docSession !== undefined;

  useEffect(() => {
    if (host.current === null) return undefined;
    const instance = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          lineNumbers(),
          syntaxHighlighting(nexusHighlightStyle, { fallback: true }),
          EditorState.readOnly.of(!writable),
          EditorView.editable.of(writable),
          language.current.of([]),
          nexusEditorTheme,
          ...(collab.current.docSession !== undefined
            ? [collabExtension(collab.current.docSession, path, collab.current.selfId ?? '')]
            : []),
        ],
      }),
    });
    view.current = instance;
    return () => {
      instance.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Content changes — including switching to a different file — replace the
  // document in place rather than rebuilding the view. Collaborative mode
  // skips this entirely: once a DocSession owns the document, `cmCollab.ts`
  // is the only thing allowed to move its text (via a real CRDT merge), and
  // blindly dispatching a stale REST snapshot here on top of it would be the
  // exact whole-document replace that routing edits through a CRDT exists to
  // avoid — clobbering live keystrokes with whatever `useWorkspace` last
  // fetched from disk.
  useEffect(() => {
    if (writable) return;
    const instance = view.current;
    if (instance === null || instance.state.doc.toString() === content) return;
    instance.dispatch({ changes: { from: 0, to: instance.state.doc.length, insert: content } });
  }, [content, writable]);

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
