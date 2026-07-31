import { RoomMock } from '../components/RoomMock.js';

export function Hero(): JSX.Element {
  return (
    <section aria-labelledby="hero-heading" className="px-4 pb-16 pt-16 sm:px-6 sm:pb-24 sm:pt-24">
      <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-2">
        <div>
          <h1
            id="hero-heading"
            className="text-4xl font-bold leading-[1.05] tracking-[-0.02em] text-fg sm:text-5xl lg:text-6xl"
          >
            One agent. One context window. Everyone in the room.
          </h1>
          <p className="mt-6 max-w-prose text-lg leading-relaxed text-fg-muted">
            Nexus turns an AI coding session from a process into a room — multiple people open one
            link, see the same live agent output, take turns driving, and collectively approve or
            block what the agent is about to do. Nobody re-explains anything. Nobody
            screen-shares.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <a
              href="/new"
              className="flex min-h-[44px] items-center rounded-md bg-accent px-6 py-3 text-base font-medium text-bg transition-colors duration-150 hover:bg-accent-dim hover:text-fg"
            >
              Open a room
            </a>
            <a
              href="#how"
              className="flex min-h-[44px] items-center rounded-md border border-border px-6 py-3 text-base font-medium text-fg transition-colors duration-150 hover:bg-surface"
            >
              How it works
            </a>
          </div>
        </div>

        <div className="flex justify-center lg:justify-end">
          <RoomMock />
        </div>
      </div>
    </section>
  );
}
