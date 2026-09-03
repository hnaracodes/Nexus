import { useEffect, useRef, useState } from 'react';

/**
 * The opening film.
 *
 * Two figures, two machines, one agent. They both watch it finish, both get the
 * same green check, and they high-five — then the camera punches through the
 * space between them into the page.
 *
 * It is a thesis, not decoration: the whole product argument is "one agent, two
 * people, same screen, shared approval," and that is easier to *show* in six
 * seconds of line art than to explain in a paragraph of hero copy.
 *
 * Three rules it must never break:
 *
 * 1. **It is an overlay, never a gate.** The landing page renders underneath in
 *    full. If JS fails, a crawler indexes, or the user hits Skip on frame one,
 *    the content is already there — nothing waits on the animation.
 * 2. **`prefers-reduced-motion` skips it entirely.** Not "plays it slower": a
 *    fast zoom through a tunnel is exactly the vestibular trigger that setting
 *    exists for.
 * 3. **Once per session.** A film you cannot avoid on every navigation stops
 *    being delightful somewhere around the third viewing.
 */

const SEEN_KEY = 'nexus:intro-seen';

/** Beat boundaries in ms. The whole thing is under 7 seconds by design. */
const BEATS = {
  draw: 0, //      figures and desks stroke themselves on
  link: 1300, //   both screens wake; a pulse travels between them — ONE agent
  check: 2900, //  the green check strokes onto both screens at once
  highFive: 4200, // arms swing up and meet
  portal: 5300, // camera punches through
  done: 6600,
};

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function alreadySeen(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(SEEN_KEY) === '1';
  } catch {
    // Private mode / storage disabled. Treat as unseen; the film is harmless.
    return false;
  }
}

function markSeen(): void {
  try {
    globalThis.sessionStorage?.setItem(SEEN_KEY, '1');
  } catch {
    /* storage disabled — the film simply plays again next navigation */
  }
}

/**
 * One person: head, torso, two arms, seated at a desk with a screen.
 * Deliberately six strokes and no face. A more detailed figure reads as a
 * specific person, and the moment a viewer asks "who is that" they have stopped
 * reading it as "anyone, working with someone else".
 */
function Figure({
  mirrored,
  phase,
}: {
  mirrored: boolean;
  phase: 'draw' | 'link' | 'check' | 'highFive' | 'portal';
}): JSX.Element {
  const raised = phase === 'highFive' || phase === 'portal';
  const showCheck = phase === 'check' || phase === 'highFive' || phase === 'portal';
  return (
    <g
      transform={mirrored ? 'translate(760,0) scale(-1,1)' : undefined}
      className="intro-figure"
      style={{ ['--figure-delay' as string]: mirrored ? '260ms' : '0ms' }}
    >
      {/* desk */}
      <path d="M40 300 H340" className="intro-stroke" style={{ ['--len' as string]: '300' }} />
      <path d="M70 300 V356" className="intro-stroke" style={{ ['--len' as string]: '56' }} />
      <path d="M310 300 V356" className="intro-stroke" style={{ ['--len' as string]: '56' }} />

      {/* monitor, sitting ON the desk and OUTBOARD of the person — the body no
          longer runs through the screen, which is what made the first pass read
          as "a head balanced on a monitor" rather than someone at a desk */}
      <rect
        x="70"
        y="196"
        width="130"
        height="84"
        rx="6"
        className="intro-stroke"
        style={{ ['--len' as string]: '428' }}
      />
      <path d="M135 280 V300" className="intro-stroke" style={{ ['--len' as string]: '20' }} />

      {/* what is on the screen — the shared agent.
          Counter-mirrored: the parent flips this whole figure, which would
          otherwise render the check backwards as a "V". */}
      <g
        className={`intro-screen ${phase === 'draw' ? 'is-off' : 'is-on'}`}
        transform={mirrored ? 'translate(270,0) scale(-1,1)' : undefined}
      >
        <rect x="76" y="202" width="118" height="72" rx="3" className="intro-screen-fill" />
        {showCheck ? (
          <path d="M108 238 l14 15 l28 -31" className="intro-check" />
        ) : (
          <>
            <path d="M88 220 H172" className="intro-line intro-line-1" />
            <path d="M88 234 H150" className="intro-line intro-line-2" />
            <path d="M88 248 H180" className="intro-line intro-line-3" />
          </>
        )}
      </g>

      {/* head + torso, clear of the monitor */}
      <circle cx="272" cy="150" r="21" className="intro-stroke" style={{ ['--len' as string]: '132' }} />
      <path d="M272 171 V268" className="intro-stroke" style={{ ['--len' as string]: '97' }} />

      {/* inner arm reaches to the keyboard; the outer arm is the one that
          high-fives, and it swings TOWARD the centre line, not away from it */}
      <path d="M272 196 L214 244" className="intro-stroke" style={{ ['--len' as string]: '75' }} />
      <path
        d={raised ? 'M272 190 L366 118' : 'M272 196 L318 242'}
        className="intro-stroke intro-arm"
        style={{ ['--len' as string]: '118' }}
      />
      {/* the hand — four strokes, enough to read as fingers, no more */}
      <g
        className="intro-arm"
        transform={raised ? 'translate(366,118) rotate(38)' : 'translate(318,242) rotate(-46)'}
      >
        <path d="M0 0 v-13" className="intro-stroke" style={{ ['--len' as string]: '13' }} />
        <path d="M5 1 v-15" className="intro-stroke" style={{ ['--len' as string]: '15' }} />
        <path d="M10 2 v-12" className="intro-stroke" style={{ ['--len' as string]: '12' }} />
        <path d="M14 4 v-9" className="intro-stroke" style={{ ['--len' as string]: '9' }} />
      </g>
    </g>
  );
}

export function CinematicIntro(): JSX.Element | null {
  // Decide before first paint whether we play at all, so a skipped intro never
  // flashes a black overlay over the hero.
  const [playing, setPlaying] = useState(() => !prefersReducedMotion() && !alreadySeen());
  const [phase, setPhase] = useState<'draw' | 'link' | 'check' | 'highFive' | 'portal'>('draw');
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (!playing) return undefined;
    markSeen();
    const at = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));
    at(BEATS.link, () => setPhase('link'));
    at(BEATS.check, () => setPhase('check'));
    at(BEATS.highFive, () => setPhase('highFive'));
    at(BEATS.portal, () => setPhase('portal'));
    at(BEATS.done, () => setPlaying(false));
    return () => {
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
    };
  }, [playing]);

  // Escape is the universal "let me out". Bound while the film is up only.
  useEffect(() => {
    if (!playing) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPlaying(false);
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [playing]);

  if (!playing) return null;

  return (
    <div
      className={`intro-root ${phase === 'portal' ? 'is-portal' : ''}`}
      // The page underneath is the real content; this is a decorative overlay.
      aria-hidden="true"
    >
      <div className="intro-stage">
        <svg viewBox="0 0 760 400" className="intro-svg" role="presentation">
          {/* the link between the two machines — one agent, two screens */}
          <path
            d="M200 238 C 300 176, 460 176, 560 238"
            className={`intro-link ${phase === 'draw' ? 'is-hidden' : ''}`}
          />
          {phase !== 'draw' && (
            <circle r="4" className="intro-pulse">
              <animateMotion
                dur="1.15s"
                repeatCount="indefinite"
                path="M200 238 C 300 176, 460 176, 560 238"
              />
            </circle>
          )}

          <Figure mirrored={false} phase={phase} />
          <Figure mirrored phase={phase} />

          {/* impact burst at the moment of contact */}
          {(phase === 'highFive' || phase === 'portal') && (
            <g className="intro-burst">
              {[0, 60, 120, 180, 240, 300].map((angle) => (
                <path
                  key={angle}
                  d="M380 112 v-11"
                  className="intro-burst-ray"
                  // The angle rides in a custom property rather than the SVG
                  // `transform` attribute: a CSS `transform` in the keyframes
                  // OVERRIDES the attribute outright, which collapsed every ray
                  // onto the same vertical and turned six spokes into a smear.
                  style={{ ['--angle' as string]: `${angle}deg` }}
                />
              ))}
            </g>
          )}
        </svg>

        {/* speed lines — only exist during the punch-through */}
        {phase === 'portal' && (
          <div className="intro-speed">
            {Array.from({ length: 28 }, (_, i) => (
              <span
                key={i}
                className="intro-speed-line"
                style={{
                  ['--angle' as string]: `${(360 / 28) * i}deg`,
                  ['--delay' as string]: `${(i % 5) * 22}ms`,
                }}
              />
            ))}
          </div>
        )}
      </div>

      <button type="button" className="intro-skip" onClick={() => setPlaying(false)}>
        Skip intro
        <span className="intro-skip-key">Esc</span>
      </button>
    </div>
  );
}
