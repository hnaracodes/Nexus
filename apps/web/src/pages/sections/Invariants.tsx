const INVARIANTS = [
  {
    id: 'I1',
    plain: 'One room, one agent, one context window.',
    formal: 'A room owns exactly one live query() instance. Joining never forks or re-instantiates the agent.',
  },
  {
    id: 'I2′',
    plain: 'Every prompt is admitted, ordered, attributed and turn-batched by the server.',
    formal: 'A client cannot forge attribution, cannot forge driver status, and cannot jump the batch. When instructions conflict, the driver\'s take precedence — enforced at the server, not the UI.',
  },
  {
    id: 'I3',
    plain: 'The event log is append-only and authoritative.',
    formal: 'No logged event is ever mutated or deleted. Every view of room state — live, rejoined, or replayed — is reconstructible from the log alone.',
  },
  {
    id: 'I4',
    plain: 'API keys never reach the client, never hit the log, never enter a URL.',
    formal: 'The creator\'s key lives server-side on the room object and is used only to construct the SDK client.',
  },
];

export function Invariants(): JSX.Element {
  return (
    <section aria-labelledby="invariants-heading" className="px-4 py-16 sm:px-6 sm:py-24">
      <div className="mx-auto max-w-6xl">
        <h2 id="invariants-heading" className="text-2xl font-semibold text-fg sm:text-3xl">
          Four invariants, not four opinions
        </h2>
        <p className="mt-4 max-w-prose text-base leading-relaxed text-fg-muted">
          These are correctness properties, not defaults you can turn off. Violating one produces
          a system that silently corrupts itself.
        </p>
        <div className="mt-10 grid gap-6 sm:grid-cols-2">
          {INVARIANTS.map((inv) => (
            <div
              key={inv.id}
              className="card-lift rounded-lg border border-border bg-surface p-6 hover:border-accent/40"
            >
              <h3 className="flex items-baseline gap-2 text-lg font-semibold text-fg">
                <span className="font-mono text-sm text-accent">{inv.id}</span>
                {inv.plain}
              </h3>
              <p className="mt-3 rounded-md bg-bg p-3 font-mono text-xs leading-relaxed text-fg-muted">
                <span className="text-fg-muted/60">{'// '}</span>
                {inv.formal}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
