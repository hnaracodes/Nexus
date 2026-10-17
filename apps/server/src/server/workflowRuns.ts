/**
 * Keeps workflow runs ALIVE after the route that started them has returned.
 *
 * `workflowRunner.ts` is pull-based: a run only advances when something calls
 * `run.poll()`. The run route used to start the run and drop it, so only a
 * graph's ROOT nodes ever spawned and every downstream node stayed 'pending'
 * forever. This registry is the missing caller: it holds the run per
 * (room, workflow) and polls it on an interval until it settles, and it is
 * also what lets `GET .../run` report which agent became which node.
 *
 * It adds no authority. Polling only decides WHEN the runner spawns the next
 * ready node; every spawned agent still goes through `spawnAgent` and the
 * room's approval gate exactly as before.
 */
import type { AgentId } from '@syncode/protocol/events';
import type { NodeStatus, WorkflowRun } from './workflowRunner.js';

export interface RunSnapshot {
  nodes: Array<[string, AgentId]>;
  statuses: Record<string, NodeStatus>;
  settled: boolean;
}

interface Entry {
  run: WorkflowRun;
  nodeIds: string[];
  timer: ReturnType<typeof setInterval> | null;
}

export interface StartTracking {
  key: string;
  run: WorkflowRun;
  nodeIds: string[];
  /** Called after every poll (e.g. to push a fresh `fleet` frame). */
  onTick?: () => void;
  /** Polling stops as soon as this returns false (the room went away). */
  alive?: () => boolean;
}

export interface RunRegistry {
  start(args: StartTracking): void;
  snapshot(key: string): RunSnapshot | undefined;
  /** Stops every timer. For shutdown and tests. */
  stopAll(): void;
}

export function runKey(roomId: string, crewName: string): string {
  return JSON.stringify([roomId, crewName]);
}

export function createRunRegistry(opts: { intervalMs?: number } = {}): RunRegistry {
  const intervalMs = opts.intervalMs ?? 1000;
  const entries = new Map<string, Entry>();

  function stopTimer(entry: Entry): void {
    if (entry.timer !== null) clearInterval(entry.timer);
    entry.timer = null;
  }

  return {
    start({ key, run, nodeIds, onTick, alive }) {
      // A new run for the same workflow REPLACES the old one. Its timer is
      // stopped; agents it already spawned keep running and stay visible in
      // the fleet, they are simply no longer advanced by this registry.
      const previous = entries.get(key);
      if (previous !== undefined) stopTimer(previous);

      const entry: Entry = { run, nodeIds, timer: null };
      entries.set(key, entry);
      if (run.settled) return;

      entry.timer = setInterval(() => {
        try {
          if (alive !== undefined && !alive()) {
            stopTimer(entry);
            return;
          }
          run.poll();
          onTick?.();
          if (run.settled) stopTimer(entry);
        } catch {
          // A poll that throws would throw on every later tick too. Stop
          // rather than spin; the snapshot keeps reporting the last known
          // statuses, which is the honest answer.
          stopTimer(entry);
        }
      }, intervalMs);
      // Never keep the process alive just to poll a run.
      entry.timer.unref?.();
    },

    snapshot(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      const statuses: Record<string, NodeStatus> = {};
      for (const id of entry.nodeIds) {
        const status = entry.run.status(id);
        if (status !== undefined) statuses[id] = status;
      }
      return { nodes: [...entry.run.nodeAgentIds.entries()], statuses, settled: entry.run.settled };
    },

    stopAll() {
      for (const entry of entries.values()) stopTimer(entry);
      entries.clear();
    },
  };
}
