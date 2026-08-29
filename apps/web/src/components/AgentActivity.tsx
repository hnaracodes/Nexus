import { Circle, FileText, ShieldAlert, Terminal } from 'lucide-react';
import type { AgentStatus } from '../agentStatus.js';

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']);

function toolIcon(toolName: string) {
  return FILE_TOOLS.has(toolName) ? FileText : Terminal;
}

/**
 * Props take `now` rather than starting its own timer — App.tsx already ticks
 * once a second (App.tsx:46-49) and a second interval would drift against it
 * pointlessly.
 */
export function AgentActivity({ status, now }: { status: AgentStatus; now: number }): JSX.Element {
  switch (status.state) {
    case 'idle':
      return (
        <div role="status" aria-live="polite" className="flex items-center gap-2 text-fg-muted">
          <Circle size={16} strokeWidth={2} aria-hidden="true" />
          <span className="text-sm">Idle</span>
        </div>
      );

    case 'thinking':
      return (
        <div role="status" aria-live="polite" className="flex items-center gap-2 text-accent">
          <Circle size={16} strokeWidth={2} fill="currentColor" className="animate-nexus-pulse" aria-hidden="true" />
          <span className="text-sm">Thinking…</span>
        </div>
      );

    case 'streaming':
      return (
        <div role="status" aria-live="polite" className="flex items-center gap-2 text-accent">
          <Circle size={16} strokeWidth={2} fill="currentColor" className="animate-nexus-pulse" aria-hidden="true" />
          <span className="text-sm">Responding…</span>
        </div>
      );

    case 'tool': {
      const Icon = toolIcon(status.toolName);
      const seconds = Math.max(0, Math.floor((now - status.startedAt) / 1000));
      return (
        <div role="status" aria-live="polite" className="flex items-center gap-2 text-accent">
          <Icon size={16} strokeWidth={2} aria-hidden="true" />
          <span className="text-sm">
            Running <code className="font-mono">{status.toolName}</code> · {seconds}s
          </span>
        </div>
      );
    }

    case 'awaiting':
      return (
        <div role="status" aria-live="assertive" className="flex items-center gap-2 text-warn">
          <ShieldAlert size={16} strokeWidth={2} className="animate-nexus-pulse" aria-hidden="true" />
          <span className="text-sm">Waiting for the room to approve</span>
        </div>
      );
  }
}
