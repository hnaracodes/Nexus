export function StopButton({ onStop, busy }: { onStop: () => void; busy: boolean }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onStop}
      title="Anyone in the room can stop the agent"
      className={`rounded px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
        busy ? 'bg-danger text-fg' : 'border border-danger text-danger'
      }`}
    >
      Stop
    </button>
  );
}
