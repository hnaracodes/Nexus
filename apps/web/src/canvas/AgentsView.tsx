import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentId, AgentProvider } from '@syncode/protocol/events';
import type { FleetEntry } from '@syncode/protocol/wire';
import { Canvas } from './Canvas.js';
import { EmptyState } from './EmptyState.js';
import { FleetStrip } from './FleetStrip.js';
import { EdgeInspector, NodeInspector } from './Inspector.js';
import { Palette } from './Palette.js';
import { RunOverlay } from './RunOverlay.js';
import { DEFAULT_TASK, WorkflowBar } from './WorkflowBar.js';
import { createRoomApi } from './api.js';
import type { Library, SavedConfig } from './api.js';
import { ensurePresetConfig } from './ensurePreset.js';
import { validate } from './graph.js';
import type { Graph } from './graph.js';
import {
  addEdge,
  addNode,
  autoArrange,
  fromCrew,
  layoutModeFor,
  moveNode,
  removeEdge,
  removeNode,
  saveBlockers,
  updateNode,
  upstreamOf,
} from './graphOps.js';
import type { LayoutMode, Point } from './graphOps.js';
import { readStoredIdentities } from './identity.js';
import { findPreset } from './presets.js';
import type { ConfigBody } from './presets.js';
import { useRun } from './useRun.js';

/**
 * The room's agents surface: everything about building, launching and watching
 * agents and agent networks lives behind this one component.
 *
 * THIS PROPS INTERFACE IS A SEAM (phase 18). The shell (`App.tsx`) decides
 * WHERE this renders; this file and everything under `canvas/` decides WHAT it
 * shows. Neither side edits the other's file - a change to these props is a
 * change to both, and lands on `main` as its own commit.
 *
 * The canvas remains a VIEW over the orchestration model (phase 14): a node is
 * an agent built from a saved config, an edge is a dependency, and every node's
 * tool calls hit the same approval gate as a hand-spawned agent. Nothing drawn
 * here may imply consent.
 */
export interface AgentsViewProps {
  roomId: string;
  /** The room token. Every config/crew route is token-authenticated and
   *  room-scoped (CLAUDE.md §11) - never call them without it. */
  token: string;
  /** The live `fleet` frame, verbatim. Liveness only; membership is the log. */
  fleet: FleetEntry[];
  focusedAgentId: AgentId | null;
  onFocusAgent: (agentId: AgentId | null) => void;
  /** Sends `spawn_agent`. The server refuses a non-driver; surface that, don't pre-empt it. */
  onSpawnAgent: (params: {
    displayName: string;
    provider: AgentProvider;
    model: string | null;
    configName?: string;
  }) => void;
  onStopAgent: (agentId: AgentId) => void;
  /** Ask the shell to show this agent's conversation, wherever the shell keeps it. */
  onOpenAgentChat: (agentId: AgentId) => void;
}

type Selection = { kind: 'node'; id: string } | { kind: 'edge'; from: string; to: string } | null;
interface Banner {
  tone: 'error' | 'info';
  text: string;
  problems?: string[];
}

const EMPTY_GRAPH: Graph = { nodes: [], edges: [] };
const EMPTY_LIBRARY: Library = { configs: [], crews: [] };

export function AgentsView({
  roomId,
  token,
  fleet,
  focusedAgentId,
  onFocusAgent,
  onSpawnAgent,
  onStopAgent,
  onOpenAgentChat,
}: AgentsViewProps): JSX.Element {
  const api = useMemo(() => createRoomApi(roomId, token), [roomId, token]);
  const [library, setLibrary] = useState<Library>(EMPTY_LIBRARY);
  const [graph, setGraph] = useState<Graph>(EMPTY_GRAPH);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const [name, setName] = useState('');
  const [loadedName, setLoadedName] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState(JSON.stringify(EMPTY_GRAPH));
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [task, setTask] = useState('');
  const [banner, setBanner] = useState<Banner | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<LayoutMode>('wide');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { run, track } = useRun(api);

  // Layout follows the width this view is GIVEN (it may sit in a 260px side
  // bar or fill a tab). jsdom has no ResizeObserver: default to 'wide'.
  useEffect(() => {
    const el = rootRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      if (width > 0) setMode(layoutModeFor(width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const refreshLibrary = useCallback(async (): Promise<void> => {
    const res = await api.library();
    if (res.ok) {
      setLibrary(res.data);
    } else {
      // Never read a failed load as "no workflows": say what the server said.
      setBanner({ tone: 'error', text: `Could not load saved agents and workflows. ${res.message}` });
    }
  }, [api]);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  const configNames = useMemo(() => new Set(library.configs.map((c) => c.name)), [library.configs]);
  const dirty = JSON.stringify(graph) !== snapshot || (savedAs !== null && savedAs !== name.trim());
  const blockers = saveBlockers(name, graph, configNames);
  const saveBlocker = blockers.length === 0 ? null : blockers.join(' ');
  const runBlocker = saveBlocker;

  const selectedNode = selection?.kind === 'node' ? graph.nodes.find((n) => n.id === selection.id) : undefined;
  const selectedEdge =
    selection?.kind === 'edge' && graph.edges.some((e) => e.from === selection.from && e.to === selection.to)
      ? selection
      : null;

  function noteConfig(config: SavedConfig): void {
    setLibrary((lib) => ({
      ...lib,
      configs: [...lib.configs.filter((c) => c.name !== config.name), config],
    }));
  }

  // ------------------------------------------------------------ editing ---

  async function addAgent(payload: string, at?: Point): Promise<void> {
    const [kind, ...rest] = payload.split(':');
    const key = rest.join(':');
    let configName: string;
    let base: string;
    if (kind === 'preset') {
      const preset = findPreset(key);
      if (preset === undefined) return;
      // Save the config BEFORE the node exists, so a run never meets a node
      // whose config was never stored. An existing config is left untouched.
      const ensured = await ensurePresetConfig(preset, library.configs, api);
      if (!ensured.ok) {
        setBanner({ tone: 'error', text: `Could not add ${preset.name}.`, problems: ensured.problems.length > 0 ? ensured.problems : [ensured.message] });
        return;
      }
      if (ensured.data.created) noteConfig(ensured.data.config);
      configName = ensured.data.config.name;
      base = preset.name;
    } else if (kind === 'config') {
      if (!configNames.has(key)) {
        setBanner({ tone: 'error', text: `The config "${key}" is not saved.` });
        return;
      }
      configName = key;
      base = key;
    } else {
      return;
    }
    setBanner(null);
    // Read the LATEST graph (a ref): an await above may have let it change.
    const added = addNode(graphRef.current, { configName, name: base, ...(at === undefined ? {} : { at }) });
    graphRef.current = added.graph;
    setGraph(added.graph);
    setSelection({ kind: 'node', id: added.node.id });
  }

  const connect = (from: string, to: string): string | null => {
    const result = addEdge(graph, from, to);
    if (!result.ok) return result.reason;
    setGraph(result.graph);
    return null;
  };
  const checkConnect = (from: string, to: string): string | null => {
    const result = addEdge(graph, from, to);
    return result.ok ? null : result.reason;
  };

  function deleteSelection(): void {
    if (selection?.kind === 'node') setGraph((g) => removeNode(g, selection.id));
    else if (selection?.kind === 'edge') setGraph((g) => removeEdge(g, selection.from, selection.to));
    setSelection(null);
  }

  // ----------------------------------------------------------- workflows ---

  function loadWorkflow(crewName: string): void {
    const crew = library.crews.find((c) => c.name === crewName);
    if (crew === undefined) return;
    const loaded = fromCrew(crew);
    setGraph(loaded);
    setName(crew.name);
    setLoadedName(crew.name);
    setSavedAs(crew.name);
    setSnapshot(JSON.stringify(loaded));
    setSelection(null);
    const check = validate(loaded);
    setBanner(check.ok ? null : { tone: 'error', text: `"${crew.name}" has problems.`, problems: check.problems });
  }

  /** Saves; returns whether it succeeded. */
  async function saveWorkflow(): Promise<boolean> {
    if (saveBlocker !== null) {
      setBanner({ tone: 'error', text: saveBlocker });
      return false;
    }
    const res = await api.saveCrew(name, graph);
    if (!res.ok) {
      setBanner({ tone: 'error', text: `Could not save "${name.trim()}".`, problems: res.problems.length > 0 ? res.problems : [res.message] });
      return false;
    }
    setLoadedName(name.trim());
    setSavedAs(name.trim());
    setSnapshot(JSON.stringify(graph));
    await refreshLibrary();
    setBanner({ tone: 'info', text: `Saved "${name.trim()}".` });
    return true;
  }

  async function deleteWorkflow(): Promise<void> {
    if (loadedName === null) return;
    setBusy(true);
    const res = await api.deleteCrew(loadedName);
    setBusy(false);
    if (!res.ok) {
      setBanner({ tone: 'error', text: res.message });
      return;
    }
    setLoadedName(null);
    setSavedAs(null);
    setBanner({ tone: 'info', text: `Deleted "${loadedName}".` });
    await refreshLibrary();
  }

  async function runWorkflow(): Promise<void> {
    if (runBlocker !== null) {
      setBanner({ tone: 'error', text: runBlocker });
      return;
    }
    setBusy(true);
    try {
      if (dirty || savedAs === null) {
        if (!(await saveWorkflow())) return;
      }
      const res = await api.run(name.trim(), task.trim() === '' ? DEFAULT_TASK : task.trim(), readStoredIdentities(roomId));
      if (!res.ok) {
        // The server's own sentence, verbatim (e.g. who may run a workflow).
        setBanner({ tone: 'error', text: res.message });
        return;
      }
      setBanner({ tone: 'info', text: 'Run started. Every agent still asks the room for approval before it acts.' });
      track(name.trim());
    } finally {
      setBusy(false);
    }
  }

  // --------------------------------------------------------- inspector ---

  const inspector =
    selectedNode !== undefined ? (
      <NodeInspector
        key={selectedNode.id}
        node={selectedNode}
        config={library.configs.find((c) => c.name === selectedNode.configName)}
        usedBy={graph.nodes.filter((n) => n.configName === selectedNode.configName).length}
        others={graph.nodes.filter((n) => n.id !== selectedNode.id)}
        upstream={upstreamOf(graph, selectedNode.id)}
        onUpdateNode={(patch) => setGraph((g) => updateNode(g, selectedNode.id, patch))}
        onToggleUpstream={(otherId, checked) => {
          if (!checked) {
            setGraph((g) => removeEdge(g, otherId, selectedNode.id));
            return null;
          }
          return connect(otherId, selectedNode.id);
        }}
        onDeleteNode={deleteSelection}
        onApply={async (body: ConfigBody) => {
          const res = await api.saveConfig(body);
          if (res.ok) noteConfig(res.data);
          return res;
        }}
        onSaveAsNew={async (body: ConfigBody) => {
          const res = await api.saveConfig(body);
          if (res.ok) {
            noteConfig(res.data);
            setGraph((g) => updateNode(g, selectedNode.id, { configName: res.data.name }));
          }
          return res;
        }}
      />
    ) : selectedEdge !== null ? (
      <EdgeInspector
        fromName={graph.nodes.find((n) => n.id === selectedEdge.from)?.displayName ?? selectedEdge.from}
        toName={graph.nodes.find((n) => n.id === selectedEdge.to)?.displayName ?? selectedEdge.to}
        onDelete={deleteSelection}
      />
    ) : (
      <p className="text-xs text-fg-muted">Select an agent or a connection to edit it.</p>
    );

  const wide = mode === 'wide';

  return (
    <div ref={rootRef} data-layout={mode} className="flex h-full min-h-0 w-full min-w-0 flex-col bg-bg">
      <FleetStrip
        fleet={fleet}
        focusedAgentId={focusedAgentId}
        configs={library.configs}
        api={api}
        onConfigSaved={noteConfig}
        onFocusAgent={onFocusAgent}
        onSpawnAgent={onSpawnAgent}
        onStopAgent={onStopAgent}
        onOpenAgentChat={onOpenAgentChat}
      />
      <WorkflowBar
        crews={library.crews}
        loadedName={loadedName}
        name={name}
        onName={setName}
        task={task}
        onTask={setTask}
        onLoad={loadWorkflow}
        onSave={() => {
          setBusy(true);
          void saveWorkflow().finally(() => setBusy(false));
        }}
        onDelete={() => void deleteWorkflow()}
        onRun={() => void runWorkflow()}
        saveBlocker={saveBlocker}
        runBlocker={runBlocker}
        willReplace={library.crews.some((c) => c.name === name.trim()) && loadedName !== name.trim()}
        busy={busy}
      />
      {banner !== null && (
        <div
          role={banner.tone === 'error' ? 'alert' : 'status'}
          className={`border-b px-3 py-1.5 text-xs ${
            banner.tone === 'error' ? 'border-danger/40 bg-danger/10 text-danger' : 'border-border bg-surface-2 text-fg'
          }`}
        >
          <p>{banner.text}</p>
          {banner.problems !== undefined && (
            <ul className="ml-4 list-disc">
              {banner.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {!wide && <Palette variant="menu" configs={library.configs} onAdd={(p) => void addAgent(p)} />}
      <div className={`flex min-h-0 flex-1 ${wide ? 'flex-row' : 'flex-col'}`}>
        {wide && <Palette variant="sidebar" configs={library.configs} onAdd={(p) => void addAgent(p)} />}
        <div className="relative min-h-[240px] min-w-0 flex-1">
          <Canvas
            graph={graph}
            selectedNodeId={selection?.kind === 'node' ? selection.id : null}
            selectedEdge={selectedEdge === null ? null : { from: selectedEdge.from, to: selectedEdge.to }}
            onSelect={(id) => setSelection({ kind: 'node', id })}
            onSelectEdge={(from, to) => setSelection({ kind: 'edge', from, to })}
            onClearSelection={() => setSelection(null)}
            onNodeMove={(id, x, y) => setGraph((g) => moveNode(g, id, x, y))}
            onConnect={connect}
            checkConnect={checkConnect}
            onDeleteSelection={deleteSelection}
            onDropAgent={(payload, world) => void addAgent(payload, world)}
            onAutoArrange={() => setGraph((g) => autoArrange(g))}
            emptyState={<EmptyState onAdd={(p) => void addAgent(p)} />}
          >
            {run.started && <RunOverlay graph={graph} fleet={fleet} nodeAgentIds={run.nodeAgentIds} />}
          </Canvas>
        </div>
        <aside
          aria-label="Inspector"
          className={`shrink-0 overflow-y-auto border-border bg-surface p-3 ${
            wide ? 'w-72 border-l' : 'max-h-[40%] border-t'
          }`}
        >
          {inspector}
        </aside>
      </div>
      {run.started && (
        <p role="status" className="border-t border-border bg-surface px-3 py-1 text-xs text-fg-muted">
          {run.settled ? 'Run finished.' : 'Run in progress.'}
        </p>
      )}
    </div>
  );
}
