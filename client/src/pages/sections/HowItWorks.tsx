import { KeyRound, Link2, ShieldAlert, Users } from 'lucide-react';

const STEPS = [
  {
    icon: KeyRound,
    title: 'Paste a Console API key',
    body: 'An Anthropic Console key (sk-ant-…), held server-side for the life of the room.',
  },
  {
    icon: Link2,
    title: 'Share the room link',
    body: 'The link is the credential. Anyone who opens it is a full participant.',
  },
  {
    icon: Users,
    title: 'Everyone types, the server orders and attributes',
    body: 'Every prompt is admitted, timestamped and attributed to its author — no interleaved garbage, no silent drops.',
  },
  {
    icon: ShieldAlert,
    title: 'The room approves anything destructive',
    body: 'Before a risky tool call runs, any participant can approve or deny it. The agent waits.',
  },
];

export function HowItWorks(): JSX.Element {
  return (
    <section id="how" aria-labelledby="how-heading" className="px-4 py-16 sm:px-6 sm:py-24">
      <div className="mx-auto max-w-6xl">
        <h2 id="how-heading" className="text-2xl font-semibold text-fg sm:text-3xl">
          How it works
        </h2>
        <ol className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(({ icon: Icon, title, body }, index) => (
            <li
              key={title}
              className="card-lift rounded-xl border border-border bg-surface p-6 hover:border-accent/40"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-dim text-sm font-bold text-fg">
                  {index + 1}
                </span>
                <Icon size={20} className="text-fg-muted" aria-hidden="true" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-fg">{title}</h3>
              <p className="mt-2 text-base leading-relaxed text-fg-muted">{body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
