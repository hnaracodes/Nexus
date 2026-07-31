import { KeyRound, ShieldCheck, Users } from 'lucide-react';
import { useReveal } from '../../hooks/useReveal.js';

const FACTS = [
  {
    icon: Users,
    title: 'The room is the boundary',
    body: 'Whatever the room can do, every participant can do — read .env, use your git credentials, run commands. Invite the people you would pair with.',
  },
  {
    icon: KeyRound,
    title: 'Your key stays server-side',
    body: 'The Console key you paste never reaches a client, never enters a URL, and is scrubbed from the event log at the write boundary.',
  },
  {
    icon: ShieldCheck,
    title: 'Every decision is on the record',
    body: 'Approvals, denials, prompts and interrupts are appended to a log that is never mutated — so who signed off on what is always answerable.',
  },
] as const;

export function SecurityHonesty(): JSX.Element {
  const gridRef = useReveal<HTMLDivElement>({ stagger: true });

  return (
    <section
      id="trust"
      aria-labelledby="security-honesty-heading"
      className="relative isolate overflow-hidden border-y border-border bg-surface/60 px-4 py-20 sm:px-6 sm:py-28"
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div className="nexus-blob-b absolute -right-32 top-0 h-[26rem] w-[26rem] rounded-full bg-accent-2 opacity-[0.14] blur-[110px]" />
      </div>

      <div className="mx-auto max-w-6xl">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-wider text-accent">Trust model</p>
          <h2
            id="security-honesty-heading"
            className="mt-3 text-3xl font-bold tracking-[-0.02em] text-fg sm:text-4xl"
          >
            A shared room is a shared security boundary.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-fg-muted">
            Nexus is designed for people who already trust each other with the repository. That
            assumption is deliberate, and stating it plainly is part of the product.
          </p>
        </div>

        <div ref={gridRef} className="mt-14 grid gap-6 md:grid-cols-3">
          {FACTS.map((fact) => (
            <div
              key={fact.title}
              className="card-lift rounded-xl border border-border bg-bg/60 p-6"
            >
              <fact.icon size={22} className="text-accent" aria-hidden="true" />
              <h3 className="mt-4 text-lg font-semibold text-fg">{fact.title}</h3>
              <p className="mt-2 text-base leading-relaxed text-fg-muted">{fact.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-6 rounded-xl border border-warn/40 bg-warn/5 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-lg font-semibold text-fg">Nexus has no isolation between rooms.</p>
            <p className="mt-2 max-w-2xl text-base leading-relaxed text-fg-muted">
              One host process, one filesystem — room A can in principle reach room B&apos;s working
              directory. Run your own instance for work you would not share.
            </p>
          </div>
          <a
            href="/security"
            className="inline-flex min-h-[44px] shrink-0 items-center rounded-md border border-border bg-bg px-6 py-3 text-base font-medium text-fg transition-colors duration-150 hover:border-accent/50 hover:bg-surface-2"
          >
            Read the security model
          </a>
        </div>
      </div>
    </section>
  );
}
