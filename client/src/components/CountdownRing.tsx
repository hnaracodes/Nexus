/**
 * Decorative countdown ring for an approval card. The ring is `aria-hidden` —
 * it is redundant reinforcement, not information. The number is the
 * information: it always renders as real text, carries its own accessible
 * label, and is what survives `prefers-reduced-motion` (the ring's colour
 * transition is the only thing motion settings touch).
 */
export function CountdownRing({
  secondsLeft,
  totalSeconds,
  size = 40,
}: {
  secondsLeft: number;
  totalSeconds: number;
  size?: number;
}): JSX.Element {
  const clampedTotal = Math.max(totalSeconds, 1);
  const fraction = Math.min(1, Math.max(0, secondsLeft / clampedTotal));
  const color = fraction > 0.5 ? 'rgb(var(--accent))' : fraction > 0.2 ? 'rgb(var(--warn))' : 'rgb(var(--danger))';
  const radius = 16;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - fraction);

  return (
    <div
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 40 40"
        width={size}
        height={size}
        className="absolute inset-0 -rotate-90 transition-[stroke-dashoffset] duration-150 motion-reduce:transition-none"
      >
        <circle cx={20} cy={20} r={radius} fill="none" stroke="rgb(var(--border))" strokeWidth={3} />
        <circle
          cx={20}
          cy={20}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
      </svg>
      <span
        className="text-xs font-semibold text-fg"
        aria-label={`${secondsLeft} seconds left to decide`}
      >
        {secondsLeft}
      </span>
    </div>
  );
}
