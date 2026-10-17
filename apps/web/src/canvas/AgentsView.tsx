import { useEffect, useState } from 'react';
import type { AgentId, AgentProvider } from '@syncode/protocol/events';
import type { FleetEntry } from '@syncode/protocol/wire';
import { Button } from '../components/Button.js';
import { Canvas } from './Canvas.js';
import { RunOverlay } from './RunOverlay.js';
import type { Graph } from './graph.js';

/**
 * The room's agents surface: everything about building, launching and watching
 * agents and agent networks lives behind this one component.
 *
 * THIS PROPS INTERFACE IS A SEAM (phase 18). The shell (`App.tsx`) decides
 * WHERE this renders; this file and everything under `canvas/` decides WHAT it
 * shows. Neither side edits the other's file — a change to these props is a
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
   *  room-scoped (CLAUDE.md §11) — never call them without it. */
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

export function AgentsView({ roomId, token, fleet }: AgentsViewProps): JSX.Element | null {
  /** The workflow graph on screen, if any. */
  const [canvasGraph, setCanvasGraph] = useState<Graph | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  /** Saved crews that actually carry a graph — the only ones the canvas can draw. */
  const [graphCrews, setGraphCrews] = useState<Array<{ name: string; graph: Graph }>>([]);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    // Room-scoped and token-carrying, like every other write-capable route
    // here — see ConfigLibrary.tsx for why an unscoped config endpoint was the
    // wrong answer even though a config is not room state.
    void fetch(`/api/rooms/${encodeURIComponent(roomId)}/configs`, {
      headers: { 'X-SynCode-Token': token },
    })
      .then((r) => (r.ok ? r.json() : { crews: [] }))
      .then((body: { crews?: Array<{ name: string; graph?: Graph }> }) => {
        setGraphCrews(
          (body.crews ?? [])
            .filter((c): c is { name: string; graph: Graph } => c.graph !== undefined)
            .map((c) => ({ name: c.name, graph: c.graph })),
        );
      })
      .catch(() => setGraphCrews([]));
  }, [roomId, token]);

  if (graphCrews.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs text-fg-muted">
        <span>Workflows:</span>
        {graphCrews.map((crew) => (
          <button
            key={crew.name}
            type="button"
            onClick={() => {
              setCanvasGraph(crew.graph);
              setRunError(null);
            }}
            className="rounded border border-border px-2 py-1 text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {crew.name}
          </button>
        ))}
        {canvasGraph !== null && (
          <>
            <Button
              onClick={() => {
                const crew = graphCrews.find((c) => c.graph === canvasGraph);
                if (crew === undefined) return;
                setRunError(null);
                void fetch(
                  `/api/rooms/${encodeURIComponent(roomId)}/crews/${encodeURIComponent(crew.name)}/run`,
                  {
                    method: 'POST',
                    headers: { 'X-SynCode-Token': token, 'content-type': 'application/json' },
                    body: JSON.stringify({ prompt: 'Begin.' }),
                  },
                )
                  .then(async (r) => {
                    if (r.ok) return;
                    const body = (await r.json().catch(() => ({}))) as { error?: string };
                    // Every node in a graph is an agent that will ask
                    // permission; a refusal here is usually the fleet's
                    // resource cap, and the person needs to be told which
                    // rather than left guessing.
                    setRunError(body.error ?? 'Could not start that workflow.');
                  })
                  .catch(() => setRunError('Could not reach the server.'));
              }}
            >
              Run
            </Button>
            <button
              type="button"
              onClick={() => setCanvasGraph(null)}
              className="rounded border border-border px-2 py-1 hover:bg-surface-2"
            >
              Close
            </button>
          </>
        )}
        {runError !== null && <span className="text-danger">{runError}</span>}
      </div>

      {canvasGraph !== null && (
        <div className="relative m-3 h-72 shrink-0 overflow-hidden rounded-lg border border-border">
          <Canvas
            graph={canvasGraph}
            selectedNodeId={selectedNodeId}
            onSelect={setSelectedNodeId}
            onNodeMove={(id, x, y) =>
              setCanvasGraph((g) =>
                g === null ? g : { ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) },
              )
            }
          />
          {/* Live status comes from the transient `fleet` frame; MEMBERSHIP
              still comes from the log. Not a third source of truth. */}
          <RunOverlay graph={canvasGraph} fleet={fleet} />
        </div>
      )}
    </>
  );
}
