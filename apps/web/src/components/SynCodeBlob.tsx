import { useEffect, useRef, useState } from 'react';

/**
 * SynCode — the agent, as a character.
 *
 * A blue blob with eyes and arms. He is deliberately the only blue thing in a
 * warm ember palette: he is a *character in* the product, not a piece of its
 * chrome, and the cool blue is what makes him read as someone rather than as a
 * UI element.
 *
 * He can breathe, blink, wave, hop and dance. That is the whole repertoire and
 * it stays that small on purpose — a character with an expressions library
 * stops being charming and turns into a paperclip.
 */

export type Emote = 'idle' | 'wave' | 'dance' | 'hop';

export function SynCodeBlob({
  size = 56,
  emote = 'idle',
  waving = false,
  className = '',
  title,
}: {
  size?: number;
  emote?: Emote;
  /** Back-compat alias for `emote="wave"`. */
  waving?: boolean;
  className?: string;
  title?: string;
}): JSX.Element {
  const active: Emote = waving ? 'wave' : emote;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={`${className} ${active === 'dance' ? 'nexus-dance' : ''}`}
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
        <ellipse cx="24" cy="20" rx="8.5" ry="6" fill="#fff" opacity="0.28" />

        <g className="nexus-eyes">
          <ellipse cx="25" cy="30" rx="3.1" ry="3.7" fill="#0E2338" />
          <ellipse cx="39" cy="30" rx="3.1" ry="3.7" fill="#0E2338" />
          {/* catchlights: the difference between "alive" and "two dots" */}
          <circle cx="26.2" cy="28.6" r="1.05" fill="#fff" opacity="0.9" />
          <circle cx="40.2" cy="28.6" r="1.05" fill="#fff" opacity="0.9" />
        </g>

        <path
          d={active === 'dance' ? 'M26 38 Q32 45 38 38' : 'M27 39 Q32 43 37 39'}
          fill="none"
          stroke="#0E2338"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.75"
        />
      </g>

      {/*
        Arms drawn in ABSOLUTE user coordinates: `transform-origin` on an SVG <g>
        resolves against the SVG's own coordinate system, not the group's local
        one, so a translated group plus a small origin flung the arm into the
        corner on every wave. The pivot is literally the shoulder.
      */}
      <g
        className={
          active === 'wave'
            ? 'nexus-arm-wave'
            : active === 'dance'
              ? 'nexus-arm-dance-r'
              : undefined
        }
      >
        <path
          d="M49 37 C55 35 59 30 59 25"
          fill="none"
          stroke="rgb(var(--nexus, 90 169 255))"
          strokeWidth="5.5"
          strokeLinecap="round"
        />
        <circle cx="59" cy="24" r="3.6" fill="#8FC4FF" />
      </g>
      {/* The second arm only exists while dancing. Two arms at rest makes him
          read as a figure with limbs rather than a blob with a wave. */}
      {active === 'dance' && (
        <g className="nexus-arm-dance-l">
          <path
            d="M15 37 C9 35 5 30 5 25"
            fill="none"
            stroke="rgb(var(--nexus, 90 169 255))"
            strokeWidth="5.5"
            strokeLinecap="round"
          />
          <circle cx="5" cy="24" r="3.6" fill="#8FC4FF" />
        </g>
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------ */

const EASE = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface Leg {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  start: number;
  duration: number;
  hops: number;
}

function pickTarget(w: number, h: number, fromX: number): { x: number; y: number } {
  // Stay near the edges — the middle of the page is where the copy is — and
  // always cross to the other side, so he never jitters in place.
  const margin = 90;
  const y = margin + Math.random() * Math.max(1, h - margin * 2);
  const leftish = fromX > w / 2;
  const x = leftish ? margin + Math.random() * (w * 0.26) : w - margin - Math.random() * (w * 0.26);
  return { x, y };
}

/**
 * The roamer.
 *
 * He *travels*. This previously set `left`/`top` percentages while the
 * stylesheet transitioned `transform` — two different properties — so nothing
 * ever eased and he teleported. Position is now driven by rAF into a single
 * `translate3d`, with a hop arc, squash on landing, and a flip so he faces the
 * way he is going.
 *
 * `pointer-events: none` throughout: a mascot that swallows a click meant for
 * the primary CTA is a conversion bug wearing a smile. He does not mount at all
 * under `prefers-reduced-motion`, since movement is the entire point of him.
 */
export function SynCodeWanderer(): JSX.Element | null {
  const reduced =
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const [emote, setEmote] = useState<Emote>('idle');

  useEffect(() => {
    if (reduced) return undefined;
    const host = hostRef.current;
    if (host === null) return undefined;

    const w = (): number => globalThis.innerWidth;
    const h = (): number => globalThis.innerHeight;

    let leg: Leg | null = null;
    let restUntil = performance.now() + 1200;
    let pos = { x: w() - 120, y: h() - 170 };
    let facing = -1;
    let raf = 0;

    const place = (x: number, y: number, sx: number, sy: number): void => {
      host.style.transform =
        `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scale(${sx}, ${sy})`;
    };

    const beginLeg = (now: number): void => {
      const target = pickTarget(w(), h(), pos.x);
      const distance = Math.hypot(target.x - pos.x, target.y - pos.y);
      leg = {
        fromX: pos.x,
        fromY: pos.y,
        toX: target.x,
        toY: target.y,
        start: now,
        // Speed, not a fixed duration: a long trip should take longer, or he
        // looks dragged rather than self-propelled.
        duration: Math.min(4600, Math.max(1200, distance * 3.4)),
        hops: Math.max(2, Math.round(distance / 180)),
      };
      facing = target.x >= pos.x ? 1 : -1;
      setEmote('hop');
    };

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);

      if (leg === null) {
        place(pos.x, pos.y, facing, 1);
        if (now >= restUntil) beginLeg(now);
        return;
      }

      const t = Math.min(1, (now - leg.start) / leg.duration);
      const e = EASE(t);
      const x = leg.fromX + (leg.toX - leg.fromX) * e;
      const y = leg.fromY + (leg.toY - leg.fromY) * e;

      // Hop arc + squash. `arc` peaks between footfalls; `squash` pinches him
      // flat exactly at each landing, which is what sells weight.
      const phase = e * leg.hops * Math.PI;
      const arc = Math.abs(Math.sin(phase)) * 26;
      const landing = Math.abs(Math.cos(phase));
      const squashY = 1 - 0.16 * Math.pow(landing, 6);
      const squashX = 1 + 0.14 * Math.pow(landing, 6);

      place(x, y - arc, facing * squashX, squashY);

      if (t >= 1) {
        pos = { x: leg.toX, y: leg.toY };
        leg = null;
        // Arriving somewhere is a reason to celebrate, about half the time.
        const roll = Math.random();
        const next: Emote = roll < 0.24 ? 'dance' : roll < 0.5 ? 'wave' : 'idle';
        setEmote(next);
        restUntil = now + (next === 'idle' ? 1500 + Math.random() * 2400 : 2800);
      }
    };

    raf = requestAnimationFrame(frame);

    const onResize = (): void => {
      pos = { x: Math.min(pos.x, w() - 80), y: Math.min(pos.y, h() - 80) };
    };
    globalThis.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      globalThis.removeEventListener('resize', onResize);
    };
  }, [reduced]);

  if (reduced) return null;

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className="pointer-events-none fixed left-0 top-0 z-40"
      style={{ filter: 'drop-shadow(0 10px 20px rgb(90 169 255 / 0.35))', willChange: 'transform' }}
    >
      <SynCodeBlob size={54} emote={emote} />
    </div>
  );
}
