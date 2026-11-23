import { Square } from 'lucide-react';

/**
 * The room's safety valve, as a compact icon button inside the prompt box
 * toolbar. Always enabled: anyone in the room may stop the agent. `busy`
 * (an agent turn is running) is shown with the filled danger treatment; idle
 * is an outline, so the control is findable but not alarming.
 */
export function StopButton({ onStop, busy }: { onStop: () => void; busy: boolean }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onStop}
      aria-label="Stop"
      title="Stop the agent (anyone in the room can)"
      className={`flex h-6 w-6 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        busy ? 'bg-danger text-fg' : 'border border-danger text-danger'
      }`}
    >
      <Square size={12} aria-hidden="true" />
    </button>
  );
}
