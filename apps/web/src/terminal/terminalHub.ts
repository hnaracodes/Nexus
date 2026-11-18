import type { ServerFrame } from '@syncode/protocol/wire';

/** Where one terminal's bytes go: an xterm.js view, in practice. */
export interface TerminalSink {
  /** `reset` is true for a snapshot: clear the screen, then write the history. */
  write(data: string, reset: boolean): void;
  exited(exitCode: number | null): void;
}

export interface TerminalHub {
  /** True when the frame was terminal output and has been routed (or dropped). */
  handleFrame(frame: ServerFrame): boolean;
  /** Returns the unsubscribe. One view per terminal at a time. */
  subscribe(termId: string, sink: TerminalSink): () => void;
}

/**
 * Phase 19b. Terminal output bypasses the room reducer for the same reason
 * `doc_sync` does (see `store.ts`): it is byte-rate, and folding it into React
 * state would re-render the transcript, the roster and the approval queue on
 * every line a build prints. Frames for a terminal nobody is looking at are
 * dropped — the next attach sends the server's scrollback, so nothing is lost.
 */
export function createTerminalHub(): TerminalHub {
  const sinks = new Map<string, TerminalSink>();
  return {
    handleFrame(frame) {
      switch (frame.kind) {
        case 'term_output':
          sinks.get(frame.termId)?.write(frame.data, false);
          return true;
        case 'term_snapshot':
          sinks.get(frame.termId)?.write(frame.data, true);
          return true;
        case 'term_exit':
          sinks.get(frame.termId)?.exited(frame.exitCode);
          return true;
        default:
          return false;
      }
    },
    subscribe(termId, sink) {
      sinks.set(termId, sink);
      return () => {
        if (sinks.get(termId) === sink) sinks.delete(termId);
      };
    },
  };
}
