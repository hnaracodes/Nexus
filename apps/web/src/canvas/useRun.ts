import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentId } from '@syncode/protocol/events';
import type { NodeRunStatus, RoomApi } from './api.js';

export const RUN_POLL_MS = 1500;

export interface RunView {
  /** True once a run has been started from this view. */
  started: boolean;
  nodeAgentIds: ReadonlyMap<string, AgentId>;
  statuses: Readonly<Record<string, NodeRunStatus>>;
  /** From the server's own `settled`, never guessed. */
  settled: boolean;
}

const NONE: RunView = { started: false, nodeAgentIds: new Map(), statuses: {}, settled: false };

/**
 * Follows the last run of one workflow. `track(name)` starts polling
 * `GET .../run` until the server says `settled` (or answers 404/an error),
 * mapping each node to the agent that became it. The mapping comes ONLY from
 * the server: a node cannot be matched to a fleet entry by name or config
 * without risking collisions. Liveness is not read here; the overlay reads the
 * live `fleet` frame.
 */
export function useRun(api: Pick<RoomApi, 'runStatus'>): { run: RunView; track: (crewName: string) => void; clear: () => void } {
  const [run, setRun] = useState<RunView>(NONE);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);

  const stop = useCallback(() => {
    generation.current += 1;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const track = useCallback(
    (crewName: string) => {
      stop();
      const mine = generation.current;
      setRun({ ...NONE, started: true });
      const tick = async (): Promise<void> => {
        const res = await api.runStatus(crewName);
        if (generation.current !== mine) return; // superseded or unmounted
        if (!res.ok) return; // stop polling; the last known state stays on screen
        setRun({
          started: true,
          nodeAgentIds: new Map(res.data.nodes),
          statuses: res.data.statuses,
          settled: res.data.settled,
        });
        if (!res.data.settled) timer.current = setTimeout(() => void tick(), RUN_POLL_MS);
      };
      void tick();
    },
    [api, stop],
  );

  const clear = useCallback(() => {
    stop();
    setRun(NONE);
  }, [stop]);

  useEffect(() => stop, [stop]);

  return { run, track, clear };
}
