import { MonitorX, Repeat, ShieldQuestion } from 'lucide-react';

const CARDS = [
  {
    icon: Repeat,
    title: 'Re-explaining context, every time',
    body: 'Each teammate runs their own agent with their own copy of the conversation. Whoever joins late starts from zero, and the context drifts apart with every session.',
  },
  {
    icon: MonitorX,
    title: 'Screen-share latency, one set of hands',
    body: 'The usual workaround is a screen share: laggy, one person typing, everyone else watching a cursor. Nobody else can drive without taking over the whole call.',
  },
  {
    icon: ShieldQuestion,
    title: 'No record of who approved what',
    body: 'When an agent runs a destructive command, there is usually no trace of who signed off on it, or whether anyone did at all.',
  },
];

export function Problem(): JSX.Element {
  return (
    <section aria-labelledby="problem-heading" className="px-4 py-16 sm:px-6 sm:py-24">
      <div className="mx-auto max-w-6xl">
        <h2 id="problem-heading" className="text-2xl font-semibold text-fg sm:text-3xl">
          Working with an agent, together, is currently awkward
        </h2>
        <div className="mt-10 grid gap-6 sm:grid-cols-3">
          {CARDS.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="card-lift rounded-xl border border-border bg-surface p-6 hover:border-accent/40"
            >
              <Icon size={20} className="text-accent" aria-hidden="true" />
              <h3 className="mt-4 text-lg font-semibold text-fg">{title}</h3>
              <p className="mt-2 text-base leading-relaxed text-fg-muted">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
