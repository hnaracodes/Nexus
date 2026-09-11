import { CheckCircle2, ShieldAlert, XCircle } from 'lucide-react';

export function Governance(): JSX.Element {
  return (
    <section
      id="governance"
      aria-labelledby="governance-heading"
      className="px-4 py-16 sm:px-6 sm:py-24"
    >
      <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-2">
        <div>
          <h2 id="governance-heading" className="text-2xl font-semibold text-fg sm:text-3xl">
            Collaboration is the mechanism; governance is the product.
          </h2>
          <p className="mt-6 max-w-prose text-lg leading-relaxed text-fg-muted">
            Before a risky tool call runs, it is shown to the whole room, not just the person
            driving. Any participant can decide. The first response wins. A request nobody answers
            within 120 seconds is denied by default.
          </p>
          <p className="mt-4 max-w-prose text-base leading-relaxed text-fg-muted">
            Deciding is deliberately not gated on who holds the driver token — approval is a room
            decision, driving is a turn.
          </p>
        </div>

        <div
          aria-hidden="true"
          className="mx-auto w-full max-w-md overflow-hidden rounded-lg border border-warn/60 bg-surface"
        >
          <div className="flex items-center justify-between border-b border-warn/30 bg-warn/10 px-4 py-2.5">
            <span className="flex items-center gap-2 text-sm font-semibold text-warn">
              <ShieldAlert size={16} />
              Bash
            </span>
            <span className="font-mono text-xs text-fg-muted">47s to decide</span>
          </div>
          <div className="p-4">
            <pre className="mb-4 overflow-x-auto rounded-md bg-bg p-3 font-mono text-xs text-fg-muted">
              rm -rf build/ &amp;&amp; npm run build
            </pre>
            <div className="flex flex-wrap gap-3">
              <span className="flex items-center gap-1 rounded-md bg-accent-dim px-3 py-2 text-sm font-medium text-fg">
                <CheckCircle2 size={16} className="text-accent" />
                Approve
              </span>
              <span className="flex items-center gap-1 rounded-md bg-surface-2 px-3 py-2 text-sm font-medium text-fg">
                <XCircle size={16} />
                Deny
              </span>
            </div>
            <p className="mt-3 text-xs text-fg-muted">Anyone in the room can decide this.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
