import { useEffect, useRef, useState } from 'react';

/**
 * Nexus — the agent, as a character.
 *
 * A blue blob with two eyes and one waving arm. He is deliberately the only
 * blue thing in a warm ember palette: he is a *character in* the product, not a
 * piece of its chrome, and the cool blue is what makes him read as someone
 * rather than as a UI element.
 *
 * Six shapes total. He has no mouth-shapes, no expressions library, no idle
 * animation set. A character who can only breathe, blink and wave stays
 * charming; one who emotes at you turns into a paperclip.
 */
export function NexusBlob({
  size = 56,
  waving = false,
  className = '',
  title,
}: {
  size?: number;
  waving?: boolean;
  className?: string;
  title?: string;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      role={title === undefined ? 'presentation' : 'img'}
      aria-label={title}
      aria-hidden={title === undefined ? 'true' : undefined}
    >
      <defs>
        <radialGradient id="nexus-body-grad" cx="38%" cy="28%" r="78%">
          <stop offset="0%" stopColor="#8FC4FF" />
          <stop offset="55%" stopColor="rgb(var(--nexus, 90 169 255))" />
          <stop offset="100%" stopColor="#2E6FC4" />
        </radialGradient>
      </defs>

      <g className="nexus-body">
        {/* the blob — asymmetric on purpose; a symmetrical oval reads as an egg */}
        <path
          d="M32 6 C46 6 55 15 55.5 27 C56 38 51 49 42 54 C37 56.8 26 56.8 21 54 C12 49 7.5 39 8 27 C8.5 15 18 6 32 6 Z"
          fill="url(#nexus-body-grad)"
        />
        {/* highlight — one soft ellipse, the whole light source */}
        <ellipse cx="24" cy="20" rx="8.5" ry="6" fill="#fff" opacity="0.28" />

        <g className="nexus-eyes">
          <ellipse cx="25" cy="30" rx="3.1" ry="3.7" fill="#0E2338" />
          <ellipse cx="39" cy="30" rx="3.1" ry="3.7" fill="#0E2338" />
          {/* catchlights: the difference between "alive" and "two dots" */}
          <circle cx="26.2" cy="28.6" r="1.05" fill="#fff" opacity="0.9" />
          <circle cx="40.2" cy="28.6" r="1.05" fill="#fff" opacity="0.9" />
        </g>

        {/* a small smile, not a grin */}
        <path
          d="M27 39 Q32 43 37 39"
          fill="none"
          stroke="#0E2338"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.75"
        />
      </g>

      {/*
        The waving arm. Drawn in ABSOLUTE user coordinates rather than inside a
        translated group: `transform-origin` on an SVG <g> resolves against the
        SVG's own coordinate system, not the group's local one, so a translated
        group plus a small origin swung the whole arm off to the top-left corner
        on every wave. The pivot is now literally the shoulder.
      */}
      <g className={waving ? 'nexus-arm-wave' : undefined}>
        <path
          d="M49 37 C55 35 59 30 59 25"
          fill="none"
          stroke="rgb(var(--nexus, 90 169 255))"
          strokeWidth="5.5"
          strokeLinecap="round"
        />
        <circle cx="59" cy="24" r="3.6" fill="#8FC4FF" />
      </g>
    </svg>
  );
}

type Spot = { x: number; y: number };

/** Keeps him inside the viewport and out of the middle, where the copy lives. */
function nextSpot(): Spot {
  const edge = Math.floor(Math.random() * 4);
  const along = 12 + Math.random() * 76;
  if (edge === 0) return { x: along, y: 8 + Math.random() * 10 };
  if (edge === 1) return { x: 84 + Math.random() * 10, y: along };
  if (edge === 2) return { x: along, y: 78 + Math.random() * 12 };
  return { x: 4 + Math.random() * 10, y: along };
}

/**
 * The roamer. Nexus drifts around the edges of the landing page, hopping
 * between waypoints and squashing when he lands.
 *
 * `pointer-events: none` throughout — a mascot that swallows a click meant for
 * the primary CTA is a conversion bug wearing a smile. He also does not mount
 * at all under `prefers-reduced-motion`, since the entire point of him is
 * movement.
 */
export function NexusWanderer(): JSX.Element | null {
  const reduced =
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const [spot, setSpot] = useState<Spot>({ x: 86, y: 68 });
  const [hopping, setHopping] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (reduced) return undefined;
    let alive = true;
    const step = (): void => {
      if (!alive) return;
      setSpot(nextSpot());
      setHopping(true);
      timer.current = setTimeout(() => {
        if (!alive) return;
        setHopping(false);
        timer.current = setTimeout(step, 1600 + Math.random() * 2600);
      }, 2400);
    };
    timer.current = setTimeout(step, 2200);
    return () => {
      alive = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [reduced]);

  if (reduced) return null;

  return (
    <div
      aria-hidden="true"
      className={`nexus-char pointer-events-none fixed z-40 ${hopping ? 'is-hop' : ''}`}
      style={{
        left: `${spot.x}%`,
        top: `${spot.y}%`,
        transform: 'translate(-50%, -50%)',
        filter: 'drop-shadow(0 8px 18px rgb(90 169 255 / 0.35))',
      }}
    >
      <NexusBlob size={52} />
    </div>
  );
}
