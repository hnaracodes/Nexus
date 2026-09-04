import { useEffect, useMemo, useState } from 'react';
import { FolderTree, GitCompare, Pin, PinOff, Rows3 } from 'lucide-react';
import type { NexusEvent } from '@nexus/protocol/events';
import { deriveCurrentFile, deriveLatestEditSeqByPath, deriveTouchedFiles } from '../derive/workspaceFiles.js';
import { useWorkspace } from '../workspace/useWorkspace.js';
import type { WorkspaceApi } from '../workspace/workspaceApi.js';
import type { GitStatusEntry } from '../workspace/types.js';
import { WorkspaceError } from '../workspace/types.js';
import { ChangesTab } from './ChangesTab.js';
import type { GitStatusState } from './ChangesTab.js';
import { CodeEditor } from './CodeEditor.js';
import { FileTree } from './FileTree.js';

export interface WorkspacePaneProps {
  events: NexusEvent[];
  api: WorkspaceApi;
}

type WorkspaceTab = 'files' | 'changes' | 'preview';

const TABS: Array<{ id: WorkspaceTab; label: string; Icon: typeof FolderTree }> = [
  { id: 'files', label: 'Files', Icon: FolderTree },
  { id: 'changes', label: 'Changes', Icon: GitCompare },
  { id: 'preview', label: 'Preview', Icon: Rows3 },
];

/**
 * Tabs: Files | Changes | Preview (stub). Owns selection and follow/pin
 * state — per-person local UI state, no new room state, no arbitration.
 * Auto-follow the agent's current file is on by default; the pin toggle (or
 * manually picking a file in the tree) stops it. **Never imports `store.ts`**
 * — `events` arrives as plain `NexusEvent[]`, and file contents are cached
 * locally by `useWorkspace`, entirely outside the room's log-derived view.
 */
export function WorkspacePane({ events, api }: WorkspacePaneProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('files');
  const [pinned, setPinned] = useState(false);
  const [manualPath, setManualPath] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatusState>({ status: 'loading' });
  const [gitStatusRequested, setGitStatusRequested] = useState(false);

  const touchedFiles = useMemo(() => deriveTouchedFiles(events), [events]);
  const currentFile = useMemo(() => deriveCurrentFile(events), [events]);
  const editSeqByPath = useMemo(() => deriveLatestEditSeqByPath(events), [events]);

  const selectedPath = pinned && manualPath !== null ? manualPath : currentFile;

  const workspace = useWorkspace(api, editSeqByPath);

  useEffect(() => {
    if (selectedPath === null) return;
    if (workspace.files.has(selectedPath)) return;
    workspace.fetchFile(selectedPath);
    // Only re-run when the selected path changes — `workspace` itself is a
    // fresh object each render, and re-running on every render would refetch
    // the same path forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath]);

  function loadGitStatus(): void {
    setGitStatus({ status: 'loading' });
    api
      .getGitStatus()
      .then((entries: GitStatusEntry[]) => setGitStatus({ status: 'ready', entries }))
      .catch((error: unknown) => {
        const message = error instanceof WorkspaceError ? error.message : 'Failed to load git status.';
        setGitStatus({ status: 'error', message });
      });
  }

  useEffect(() => {
    if (activeTab !== 'changes' || gitStatusRequested) return;
    setGitStatusRequested(true);
    loadGitStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, gitStatusRequested]);

  function selectFile(path: string): void {
    setManualPath(path);
    setPinned(true);
  }

  function togglePin(): void {
    if (pinned) {
      setPinned(false);
    } else {
      setManualPath(selectedPath);
      setPinned(true);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border bg-surface">
      <div role="tablist" aria-label="Workspace" className="flex items-center border-b border-border">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            onClick={() => setActiveTab(id)}
            className={`flex min-h-11 items-center gap-1.5 border-b-2 px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface ${
              activeTab === id
                ? 'border-accent text-fg'
                : 'border-transparent text-fg-muted hover:text-fg'
            }`}
          >
            <Icon size={14} aria-hidden="true" />
            {label}
          </button>
        ))}
        {activeTab === 'files' && (
          <button
            type="button"
            onClick={togglePin}
            aria-pressed={pinned}
            className="ml-auto mr-2 flex min-h-8 items-center gap-1 rounded px-2 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
          >
            {pinned ? (
              <>
                <Pin size={12} aria-hidden="true" />
                Pinned
              </>
            ) : (
              <>
                <PinOff size={12} aria-hidden="true" />
                Following
              </>
            )}
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {activeTab === 'files' && (
          <>
            <FileTree api={api} selectedPath={selectedPath} touchedPaths={touchedFiles} onSelect={selectFile} />
            <CodeEditor
              path={selectedPath}
              cached={selectedPath !== null ? workspace.files.get(selectedPath) : undefined}
              onRefresh={workspace.refetchFile}
            />
          </>
        )}
        {activeTab === 'changes' && <ChangesTab events={events} gitStatus={gitStatus} />}
        {activeTab === 'preview' && (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-fg-muted">
            Preview is coming soon.
          </div>
        )}
      </div>
    </div>
  );
}
