/**
 * `min-h-11` is the 44px touch-target floor the design system states and every
 * other control honours. This button was ~36px — reported as a medium finding
 * in the phase-5 accessibility audit, then dropped because that session's
 * repair pass filtered to critical/high only and said nothing about what it
 * discarded. It is the room's safety valve; it should not be the hardest
 * control in the app to hit.
 */
export function StopButton({ onStop, busy }: { onStop: () => void; busy: boolean }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onStop}
      title="Anyone in the room can stop the agent"
      className={`min-h-11 rounded px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
        busy ? 'bg-danger text-fg' : 'border border-danger text-danger'
      }`}
    >
      Stop
    </button>
  );
}
