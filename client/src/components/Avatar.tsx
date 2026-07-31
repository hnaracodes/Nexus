import { Crown } from 'lucide-react';
import { avatarFor } from '../identity.js';

const SIZES = {
  sm: { box: 20, font: 9 },
  md: { box: 28, font: 12 },
} as const;

export function Avatar({
  participantId,
  displayName,
  size = 'md',
  isDriver = false,
  connected = true,
}: {
  participantId: string;
  displayName: string;
  size?: keyof typeof SIZES;
  isDriver?: boolean;
  connected?: boolean;
}): JSX.Element {
  const { initials, hue } = avatarFor(participantId, displayName);
  const dimensions = SIZES[size];

  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center rounded-full"
      style={{
        width: dimensions.box,
        height: dimensions.box,
        backgroundColor: `hsl(${hue} 55% 45%)`,
        opacity: connected ? 1 : 0.4,
        outline: isDriver ? '2px solid var(--accent)' : undefined,
        outlineOffset: isDriver ? 1 : undefined,
      }}
      title={displayName}
      aria-label={isDriver ? `${displayName}, driving` : displayName}
    >
      <span
        className="font-medium text-white"
        style={{ fontSize: dimensions.font }}
        aria-hidden="true"
      >
        {initials}
      </span>
      {isDriver && (
        <span
          className="absolute -bottom-1 -right-1 flex items-center justify-center rounded-full bg-accent text-bg"
          style={{ width: dimensions.box * 0.55, height: dimensions.box * 0.55 }}
          aria-hidden="true"
        >
          <Crown size={Math.max(8, dimensions.box * 0.35)} strokeWidth={2.5} />
        </span>
      )}
    </span>
  );
}
