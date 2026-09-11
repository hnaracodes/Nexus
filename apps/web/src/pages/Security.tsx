import { AlertTriangle, KeyRound, ShieldAlert } from 'lucide-react';
import { LegalLayout } from './LegalLayout.js';

const SECTIONS = [
  { id: 'threat-model', heading: 'Threat model' },
  { id: 'invariants', heading: 'The four invariants' },
  { id: 'the-credential', heading: 'What the credential actually is' },
  { id: 'permission-model', heading: 'The four-eyes permission model' },
  { id: 'not-protected', heading: 'What is explicitly not protected' },
  { id: 'reporting', heading: 'Reporting a vulnerability' },
];

export function Security(): JSX.Element {
  return (
    <LegalLayout title="Security" lastUpdated="2026-07-30" sections={SECTIONS}>
      <section
        aria-labelledby="opening-h"
        className="rounded-lg border border-warn/40 bg-surface p-4"
      >
        <h2 id="opening-h" className="flex items-center gap-2 text-2xl font-semibold text-fg">
          <ShieldAlert size={20} aria-hidden="true" className="text-warn" />
          Two sentences that matter more than anything else on this page
        </h2>
        <p className="mt-3 text-lg font-semibold text-fg">
          &ldquo;A shared room is a shared security boundary.&rdquo;
        </p>
        <p className="mt-3">
          Whatever the room can do, every participant in it can do — read <code>.env</code>,
          use its git credentials, run arbitrary commands through the agent. There is no
          per-participant permission tier. Only share a room link with people you would trust
          with shell access to that machine.
        </p>
        <p className="mt-4 text-lg font-semibold text-fg">
          &ldquo;SynCode has no isolation between rooms.&rdquo;
        </p>
        <p className="mt-3">
          One host process serves every room, sharing one filesystem; room A can in principle
          reach room B&rsquo;s working directory. Do not invite strangers, and do not market —
          or rely on — this as multi-tenant software.
        </p>
      </section>

      <section aria-labelledby="threat-model-h" id="threat-model">
        <h2 id="threat-model-h" className="text-2xl font-semibold text-fg">
          Threat model
        </h2>
        <p className="mt-3">
          In plain terms: everyone you invite into a room is trusted with everything that room
          can do. Everyone else — anyone who does not have the room link — is not trusted with
          anything. There is no middle tier. The room link, not an account or a role, is the
          only access-control boundary SynCode has.
        </p>
      </section>

      <section aria-labelledby="invariants-h" id="invariants">
        <h2 id="invariants-h" className="text-2xl font-semibold text-fg">
          The four invariants
        </h2>
        <p className="mt-3">These are correctness properties, not preferences. Each protects something specific.</p>
        <dl className="mt-4 flex flex-col gap-4">
          <div className="rounded-lg border border-border bg-surface p-4">
            <dt className="font-semibold text-fg">I1 — One room, one agent, one context window</dt>
            <dd className="mt-1 text-fg-muted">
              A room owns exactly one live agent session. Joining never forks or copies it, so
              everyone in the room is always looking at the same state — no one can be shown a
              different reality than anyone else.
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <dt className="font-semibold text-fg">
              I2&prime; — Every prompt is admitted, ordered, attributed and turn-batched by the
              server
            </dt>
            <dd className="mt-1 text-fg-muted">
              A client cannot forge who sent a prompt or claim driver status it does not have —
              attribution is derived server-side from the room&rsquo;s own state, never read off
              anything the browser sends. This is what stands between the room and one
              participant silently pretending to be another.
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <dt className="font-semibold text-fg">I3 — The event log is append-only and authoritative</dt>
            <dd className="mt-1 text-fg-muted">
              Nothing already written to a room&rsquo;s log is ever mutated or deleted. Every
              view of a room&rsquo;s state — live, rejoined, or replayed after a restart — is
              reconstructed from that log and nothing else, so there is no hidden state a
              participant cannot eventually see recorded.
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <dt className="font-semibold text-fg">I4 — API keys never reach the client, the log, or a URL</dt>
            <dd className="mt-1 text-fg-muted">
              The room creator&rsquo;s key lives only in server memory and is used solely to
              talk to Anthropic&rsquo;s API. It is scrubbed from logging paths and never
              serialized alongside the rest of the room&rsquo;s state.
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="the-credential-h" id="the-credential">
        <h2 id="the-credential-h" className="flex items-center gap-2 text-2xl font-semibold text-fg">
          <KeyRound size={20} aria-hidden="true" className="text-fg-muted" />
          What the credential actually is
        </h2>
        <p className="mt-3">
          A room link carries two values: a room id and an access token. The <strong>token</strong>{' '}
          is a 256-bit random value and is the actual credential — it is what &ldquo;the room
          link is the credential&rdquo; means. The <strong>room id</strong> is only 64 bits and
          is not treated as secret: it shows up in every room URL, in referrer headers on
          outbound links, and in any screenshot of the address bar. Knowing a room&rsquo;s id
          without its token grants nothing.
        </p>
      </section>

      <section aria-labelledby="permission-model-h" id="permission-model">
        <h2 id="permission-model-h" className="text-2xl font-semibold text-fg">
          The four-eyes permission model
        </h2>
        <p className="mt-3">
          Before the agent runs a tool that could change or expose something, it stops and the
          room decides. The real semantics:
        </p>
        <ul className="mt-3 list-disc pl-6">
          <li>Any participant in the room can decide — not only the driver.</li>
          <li>The first decision made wins; later responses to the same request do nothing.</li>
          <li>
            If nobody responds within 120 seconds, the request is denied automatically — a
            silent room does not default to allowing anything.
          </li>
          <li>
            A short list of read-only tools (reading a file, searching, listing) is
            auto-approved so the room is not asked to click through operations that cannot
            change anything.
          </li>
        </ul>
      </section>

      <section
        aria-labelledby="not-protected-h"
        id="not-protected"
        className="rounded-lg border border-danger/50 bg-surface p-4"
      >
        <h2
          id="not-protected-h"
          className="flex items-center gap-2 text-2xl font-semibold text-fg"
        >
          <AlertTriangle size={20} aria-hidden="true" className="text-danger" />
          What is explicitly not protected
        </h2>
        <ul className="mt-3 list-disc pl-6">
          <li>
            <strong>No isolation between rooms.</strong> One process, one filesystem, as stated
            above.
          </li>
          <li>
            <strong>No sandboxing of the agent.</strong> It runs with whatever access the
            server process itself has to its working directory and the network.
          </li>
          <li>
            <strong>Room creation requires no account or invitation.</strong> Anyone who can
            reach the server can create a room and have it clone a repository. This is
            mitigated, not eliminated, by a per-address rate limit, a cap on the total number
            of live rooms, a request body size limit, and a block on cloning from
            loopback, link-local, private-network and cloud-metadata addresses — but there is
            still no credential required to create a room in the first place.
          </li>
          <li>
            <strong>No audit export.</strong> A room&rsquo;s log can be read by an operator with
            filesystem access, but there is no built-in export or reporting tool.
          </li>
          <li>
            <strong>No deletion.</strong> See <a href="/privacy" className="text-info underline underline-offset-2">Privacy</a> — there is
            no expiry, TTL, or delete mechanism anywhere in the software.
          </li>
        </ul>
      </section>

      <section aria-labelledby="reporting-h" id="reporting">
        <h2 id="reporting-h" className="text-2xl font-semibold text-fg">
          Reporting a vulnerability
        </h2>
        <p className="mt-3">
          If you find a security issue in SynCode itself, open an issue in the project&rsquo;s
          repository, or contact whoever operates the instance you are using if the issue is
          specific to their deployment rather than the software. Please do not test against a
          room or server you were not given permission to use.
        </p>
      </section>
    </LegalLayout>
  );
}
