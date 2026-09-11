import { ArrowRight, ShieldCheck } from 'lucide-react';
import { RoomMock } from '../components/RoomMock.js';
import { useReveal } from '../../hooks/useReveal.js';

export function Hero(): JSX.Element {
  const copyRef = useReveal<HTMLDivElement>({ stagger: true, threshold: 0 });
  const mockRef = useReveal<HTMLDivElement>({ threshold: 0 });

  return (
    <section
      aria-labelledby="hero-heading"
      className="relative isolate overflow-hidden px-4 pb-20 pt-16 sm:px-6 sm:pb-28 sm:pt-24"
    >
      {/*
        Hairline grid, not a glow — purely decorative, so aria-hidden and
        pointer-events-none. Static: this reads as an editor's ground, not
        as weather.
      */}
      <div aria-hidden="true" className="code-grid pointer-events-none absolute inset-0 -z-10" />

      <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-2">
        <div ref={copyRef}>
          <p className="hero-rise inline-flex items-center gap-2 rounded-md border border-accent/30 bg-accent/10 px-3 py-1 text-sm font-medium text-accent" style={{ ['--d' as string]: '60ms' }}>
            <ShieldCheck size={16} aria-hidden="true" />
            Four-eyes approval, built in
          </p>

          <h1
            id="hero-heading"
            className="hero-rise mt-6 text-4xl font-bold leading-[1.05] tracking-[-0.02em] text-fg sm:text-5xl lg:text-6xl"
            style={{ ['--d' as string]: '160ms' }}
          >
            One agent. One context window. Everyone in the room.
          </h1>

          <p className="hero-rise mt-6 max-w-prose text-lg leading-relaxed text-fg-muted" style={{ ['--d' as string]: '300ms' }}>
            SynCode turns an AI coding session from a process into a room — multiple people open one
            link, see the same live agent output, take turns driving, and collectively approve or
            block what the agent is about to do. Nobody re-explains anything. Nobody screen-shares.
          </p>

          <div className="hero-rise mt-9 flex flex-wrap items-center gap-4" style={{ ['--d' as string]: '420ms' }}>
            <a
              href="/new"
              className="glow-accent group flex min-h-11 items-center gap-2 rounded-md bg-accent px-6 py-3 text-base font-semibold text-on-accent"
            >
              Open a room
              <ArrowRight
                size={18}
                aria-hidden="true"
                className="transition-transform duration-200 ease-emphasis group-hover:translate-x-1"
              />
            </a>
            <a
              href="#how"
              className="flex min-h-11 items-center rounded-md border border-border-strong px-6 py-3 text-base font-medium text-fg transition-colors duration-150 hover:border-accent hover:bg-surface"
            >
              How it works
            </a>
          </div>
        </div>

        <div ref={mockRef} className="hero-rise flex justify-center lg:justify-end" style={{ ['--d' as string]: '520ms' }}>
          <RoomMock />
        </div>
      </div>
    </section>
  );
}
