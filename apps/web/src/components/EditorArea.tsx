import { useState } from 'react';
import type { ReactNode } from 'react';
import { Eye } from 'lucide-react';
import type { CachedFile } from '../workspace/useWorkspace.js';
import type { DocSession } from '../workspace/docSession.js';
import { fileKind } from '../workspace/fileKinds.js';
import type { WorkspaceApi } from '../workspace/workspaceApi.js';
import { Breadcrumbs } from './Breadcrumbs.js';
import { CodeEditor } from './CodeEditor.js';
import { ImagePreview } from './ImagePreview.js';
import { MarkdownPreview } from './MarkdownPreview.js';
import { AGENTS_TAB_ID, TabStrip } from './TabStrip.js';
import type { OpenTab } from './TabStrip.js';

export interface EditorAreaProps {
  tabs: OpenTab[];
  activeId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;

  api: WorkspaceApi;
  /** The cache entry of the active file tab, if any. */
  cached: CachedFile | undefined;
  onRefresh: (path: string) => void;
  docSession: DocSession | null;
  selfId: string | null;

  /** Whether the ACTIVE markdown tab shows its preview. Per-tab state lives in the shell. */
  previewOpen: boolean;
  onTogglePreview: () => void;

  onCursorChange: (path: string, cursor: { line: number; col: number }) => void;

  /**
   * The Agents tab's content — the shell mounts `<AgentsView/>` (the phase-18
   * seam) and hands it over. It stays mounted, hidden, while another tab is
   * active, so the canvas draft survives a tab switch; it unmounts when the
   * Agents tab is closed.
   */
  agentsView: ReactNode;
}

function cachedText(cached: CachedFile | undefined): string | null {
  if (cached === undefined) return null;
  if ((cached.status === 'ready' || cached.status === 'stale') && cached.result.kind === 'text') {
    return cached.result.content;
  }
  return null;
}

/**
 * The editor column: tab strip (with title actions), then the active tab's
 * content — breadcrumbs plus a code editor (optionally split with a Markdown
 * preview), an image, or the Agents canvas.
 */
export function EditorArea(props: EditorAreaProps): JSX.Element {
  const { tabs, activeId, cached, docSession } = props;
  const agentsOpen = tabs.some((tab) => tab.id === AGENTS_TAB_ID);
  const activeIsAgents = activeId === AGENTS_TAB_ID;
  const activePath = activeId !== null && !activeIsAgents ? activeId : null;
  const kind = activePath === null ? null : fileKind(activePath);
  const showPreview = kind === 'markdown' && props.previewOpen;

  // The last text reported by the editor for a Markdown path (the editor is
  // told to report only for Markdown, so typing in a code tab never re-renders
  // this component). Reported even while the preview is closed, so reopening
  // it never shows stale text.
  const [live, setLive] = useState<{ path: string; text: string } | null>(null);
  const liveText = activePath !== null && live?.path === activePath ? live.text : null;
  // The collaborative document wins once it has content. An EMPTY session text
  // means "not populated yet" (the CRDT doc starts empty before the file is
  // seeded), so it must not mask the cached snapshot the editor was built from.
  const sessionText = activePath !== null && docSession !== null ? docSession.text(activePath) : null;
  const previewText =
    liveText ?? (sessionText !== null && sessionText !== '' ? sessionText : null) ?? cachedText(cached) ?? '';

  const actions =
    kind === 'markdown' ? (
      <button
        type="button"
        onClick={props.onTogglePreview}
        aria-pressed={props.previewOpen}
        aria-label="Open Preview to the Side"
        title="Open Preview to the Side (Ctrl/⌘+Shift+V)"
        className={`flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
          props.previewOpen ? 'bg-surface-2 text-fg' : ''
        }`}
      >
        <Eye size={16} aria-hidden="true" />
      </button>
    ) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg">
      <TabStrip
        tabs={tabs}
        activeId={activeId}
        onSelect={props.onSelectTab}
        onClose={props.onCloseTab}
        actions={actions}
      />

      {agentsOpen && (
        <div
          role="tabpanel"
          aria-label="Agents"
          className={activeIsAgents ? 'min-h-0 flex-1 overflow-auto' : 'hidden'}
        >
          {props.agentsView}
        </div>
      )}

      {!activeIsAgents && activePath !== null && <Breadcrumbs path={activePath} />}

      {!activeIsAgents && (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {kind === 'image' && activePath !== null ? (
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
              <ImagePreview api={props.api} path={activePath} />
            </div>
          ) : (
            <>
              <div className={`min-h-0 min-w-0 overflow-hidden ${showPreview ? 'w-1/2' : 'flex-1'}`}>
                <CodeEditor
                  path={activePath}
                  cached={cached}
                  onRefresh={props.onRefresh}
                  hideHeader
                  {...(docSession === null ? {} : { docSession })}
                  {...(props.selfId === null ? {} : { selfId: props.selfId })}
                  {...(activePath === null
                    ? {}
                    : { onCursorChange: (cursor: { line: number; col: number }) => props.onCursorChange(activePath, cursor) })}
                  {...(kind === 'markdown' && activePath !== null
                    ? { onDocChange: (text: string) => setLive({ path: activePath, text }) }
                    : {})}
                />
              </div>
              {showPreview && (
                <div className="min-h-0 w-1/2 min-w-0 border-l border-border">
                  <MarkdownPreview text={previewText} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
