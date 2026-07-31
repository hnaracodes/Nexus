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
        Ambient gradient mesh — purely decorative, so aria-hidden and
        pointer-events-none. Blurred blobs on a dark ground read as depth; the
        22s/27s drift is slow enough not to compete with reading, and the global
        reduced-motion rule stops it entirely.
      */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="nexus-blob-a absolute -left-32 -top-40 h-[34rem] w-[34rem] rounded-full bg-accent opacity-[0.18] blur-[110px]" />
        <div className="nexus-blob-b absolute -right-40 top-10 h-[38rem] w-[38rem] rounded-full bg-accent-2 opacity-[0.20] blur-[120px]" />
        <div className="nexus-blob-a absolute bottom-[-14rem] left-1/3 h-[26rem] w-[26rem] rounded-full bg-accent-3 opacity-[0.12] blur-[100px]" />
      </div>

      <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-2">
        <div ref={copyRef}>
          <p className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-sm font-medium text-accent">
            <ShieldCheck size={16} aria-hidden="true" />
            Four-eyes approval, built in
          </p>

          <h1
            id="hero-heading"
            className="mt-6 text-4xl font-bold leading-[1.05] tracking-[-0.02em] sm:text-5xl lg:text-6xl"
          >
            <span className="text-gradient">
              One agent. One context window. Everyone in the room.
            </span>
          </h1>

          <p className="mt-6 max-w-prose text-lg leading-relaxed text-fg-muted">
            Nexus turns an AI coding session from a process into a room — multiple people open one
            link, see the same live agent output, take turns driving, and collectively approve or
            block what the agent is about to do. Nobody re-explains anything. Nobody screen-shares.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-4">
            <a
              href="/new"
              className="glow-accent group flex min-h-[44px] items-center gap-2 rounded-md bg-accent px-6 py-3 text-base font-semibold text-bg"
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
              className="flex min-h-[44px] items-center rounded-md border border-border px-6 py-3 text-base font-medium text-fg transition-colors duration-150 hover:border-accent/50 hover:bg-surface"
            >
              How it works
            </a>
          </div>
        </div>

        <div ref={mockRef} className="flex justify-center lg:justify-end">
          <RoomMock />
        </div>
      </div>
    </section>
  );
}
