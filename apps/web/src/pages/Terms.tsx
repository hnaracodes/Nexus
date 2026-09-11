import { LegalLayout } from './LegalLayout.js';

const SECTIONS = [
  { id: 'as-is', heading: 'No warranty' },
  { id: 'responsibility', heading: 'Your responsibility' },
  { id: 'usage-costs', heading: 'Anthropic usage costs' },
  { id: 'console-keys', heading: 'Console keys only' },
  { id: 'no-isolation', heading: 'Not multi-tenant' },
  { id: 'acceptable-use', heading: 'Acceptable use' },
  { id: 'license', heading: 'License' },
  { id: 'operator-rights', heading: "The operator's rights" },
];

export function Terms(): JSX.Element {
  return (
    <LegalLayout title="Terms" lastUpdated="2026-07-30" sections={SECTIONS}>
      <section aria-labelledby="as-is-h" id="as-is">
        <h2 id="as-is-h" className="text-2xl font-semibold text-fg">
          No warranty
        </h2>
        <p className="mt-3">
          SynCode is provided as-is, with no warranty of any kind, express or implied — including
          no warranty of merchantability, fitness for a particular purpose, or that it will run
          without interruption or defect. You use it at your own risk.
        </p>
      </section>

      <section aria-labelledby="responsibility-h" id="responsibility">
        <h2 id="responsibility-h" className="text-2xl font-semibold text-fg">
          Your responsibility
        </h2>
        <p className="mt-3">
          You are responsible for what you point the agent at — the repository you clone, the
          working directory you grant it, and any credentials reachable from that environment.
          You are also responsible for everything every participant in a room you create does
          while inside it: a room has no per-participant permission tiers, and whatever the
          room can do, every participant in it can do.
        </p>
      </section>

      <section aria-labelledby="usage-costs-h" id="usage-costs">
        <h2 id="usage-costs-h" className="text-2xl font-semibold text-fg">
          Anthropic usage costs
        </h2>
        <p className="mt-3">
          A room runs against the Anthropic Console API key its creator supplied. All usage
          costs the room incurs — from every participant&rsquo;s prompts and every agent
          response — are billed to that key and are the creator&rsquo;s responsibility, not
          SynCode&rsquo;s or any other participant&rsquo;s.
        </p>
      </section>

      <section aria-labelledby="console-keys-h" id="console-keys">
        <h2 id="console-keys-h" className="text-2xl font-semibold text-fg">
          Console keys only
        </h2>
        <p className="mt-3">
          Only Anthropic Console API keys are accepted, never a Claude.ai (Free, Pro or Max)
          login, per Anthropic&rsquo;s own developer policy — see <a href="/privacy" className="text-info underline underline-offset-2">Privacy</a> for the verbatim
          wording. Do not attempt to route a subscription login through SynCode; the software
          rejects it, and doing so anyway would violate Anthropic&rsquo;s terms as well as
          these.
        </p>
      </section>

      <section aria-labelledby="no-isolation-h" id="no-isolation">
        <h2 id="no-isolation-h" className="text-2xl font-semibold text-fg">
          Not multi-tenant
        </h2>
        <p className="mt-3">
          SynCode is not multi-tenant software and must not be represented as such. One host
          process serves every room on a given deployment, sharing one filesystem; there is no
          sandbox or isolation boundary between rooms. See{' '}
          <a href="/security" className="text-info underline underline-offset-2">
            Security
          </a>{' '}
          for the full statement.
        </p>
      </section>

      <section aria-labelledby="acceptable-use-h" id="acceptable-use">
        <h2 id="acceptable-use-h" className="text-2xl font-semibold text-fg">
          Acceptable use
        </h2>
        <p className="mt-3">
          Do not use SynCode, or the agent it runs, to attack, scan, or gain unauthorized access
          to any system you do not own or have explicit permission to test. Do not use it to
          violate Anthropic&rsquo;s usage policies for the underlying model. Do not use it to
          process content you do not have the right to process.
        </p>
      </section>

      <section aria-labelledby="license-h" id="license">
        <h2 id="license-h" className="text-2xl font-semibold text-fg">
          License
        </h2>
        <p className="mt-3">
          As of this writing, the SynCode repository does not include a LICENSE file or a{' '}
          <code>license</code> field in its <code>package.json</code>. In the absence of an
          explicit license, default copyright law applies — the source is not granted under
          an open-source license and you should treat it as all-rights-reserved by its
          author unless and until a LICENSE file says otherwise. Check the repository directly
          for the current state before assuming you may redistribute or modify it.
        </p>
      </section>

      <section aria-labelledby="operator-rights-h" id="operator-rights">
        <h2 id="operator-rights-h" className="text-2xl font-semibold text-fg">
          The operator&rsquo;s rights
        </h2>
        <p className="mt-3">
          Whoever operates a given SynCode instance may remove any room, refuse to create new
          ones, or shut the instance down entirely, at any time and without notice. Nothing in
          these terms obligates an operator to keep a room, or an instance, running.
        </p>
      </section>
    </LegalLayout>
  );
}
