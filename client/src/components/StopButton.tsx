export function StopButton({ onStop, busy }: { onStop: () => void; busy: boolean }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onStop}
      title="Anyone in the room can stop the agent"
      className={`rounded px-3 py-2 text-sm ${
        busy ? 'bg-rose-600 text-white' : 'border border-rose-300 text-rose-700'
      }`}
    >
      Stop
    </button>
  );
}
