import { AlertTriangle, KeyRound, ShieldAlert } from 'lucide-react';
import { LegalLayout } from './LegalLayout.js';

const SECTIONS = [
  { id: 'what-nexus-is', heading: 'What Nexus is' },
  { id: 'no-accounts', heading: 'No accounts' },
  { id: 'your-api-key', heading: 'Your API key' },
  { id: 'console-keys-only', heading: 'Why Console keys only' },
  { id: 'what-is-recorded', heading: 'What is recorded' },
  { id: 'redaction', heading: 'Redaction is narrow' },
  { id: 'also-on-disk', heading: 'Also on disk' },
  { id: 'retention', heading: 'Retention' },
  { id: 'browser-storage', heading: 'Stored in your browser' },
  { id: 'the-link', heading: 'The room link is the credential' },
  { id: 'repo-cloning', heading: 'Repository cloning' },
  { id: 'third-parties', heading: 'Third parties' },
  { id: 'contact', heading: 'Contact and changes' },
];

/**
 * Every claim here was verified against the implementation while writing this
 * page (see the phase-5a session report for file:line citations). Re-verify
 * before editing — a privacy policy that has drifted from the code is worse
 * than none.
 */
export function Privacy(): JSX.Element {
  return (
    <LegalLayout title="Privacy" lastUpdated="2026-07-30" sections={SECTIONS}>
      <section aria-labelledby="what-nexus-is-h" id="what-nexus-is">
        <h2 id="what-nexus-is-h" className="text-2xl font-semibold text-fg">
          What Nexus is
        </h2>
        <p className="mt-3">
          Nexus is self-hostable software: source code that anyone can run on their own
          machine or server. If you reached this page through a hosted instance someone else
          is operating, that operator — not the Nexus project — controls the server, the API
          key, and the data described below. Ask them who that is if you are not sure. This
          document describes what the software itself does; it cannot describe an operator's
          policies beyond that.
        </p>
      </section>

      <section aria-labelledby="no-accounts-h" id="no-accounts">
        <h2 id="no-accounts-h" className="text-2xl font-semibold text-fg">
          No accounts
        </h2>
        <p className="mt-3">
          There is no sign-up, no email address, no password, and no user database. Nexus
          sets no cookies and includes no analytics, advertising, or third-party tracking
          script of any kind — there is nothing in this codebase that does. A room&rsquo;s
          link, a high-entropy secret, is the only credential; anyone holding it is a full
          participant.
        </p>
      </section>

      <section aria-labelledby="your-api-key-h" id="your-api-key">
        <h2 id="your-api-key-h" className="text-2xl font-semibold text-fg">
          Your API key
        </h2>
        <p className="mt-3">
          Creating a room means supplying an Anthropic Console API key (<code>sk-ant-…</code>).
          It is posted once, over HTTPS, in a request body. The server holds it in memory,
          associated with the room through a JavaScript <code>WeakMap</code> rather than a
          field on the room object itself — structurally, the key cannot be included when the
          room is serialized to JSON, sent to a client, or written to the event log. It is
          never placed in a URL and never written to the room&rsquo;s metadata file on disk.
        </p>
        <p className="mt-3">
          If the server restarts, a room comes back with its full history but{' '}
          <strong>no key</strong> — Nexus does not persist one, by design. The room refuses
          new connections with a distinct close code until its creator re-enters the key.
        </p>
      </section>

      <section
        aria-labelledby="console-keys-only-h"
        id="console-keys-only"
        className="rounded-lg border border-border bg-surface p-4"
      >
        <h2
          id="console-keys-only-h"
          className="flex items-center gap-2 text-2xl font-semibold text-fg"
        >
          <KeyRound size={20} aria-hidden="true" className="text-fg-muted" />
          Why Console keys only
        </h2>
        <p className="mt-3">
          Nexus only ever accepts an Anthropic Console API key, never a Claude.ai (Free, Pro
          or Max) login. This follows Anthropic&rsquo;s published developer policy, quoted
          here verbatim:
        </p>
        <blockquote className="mt-3 border-l-4 border-border pl-4 italic text-fg-muted">
          &ldquo;Anthropic does not permit third-party developers to offer Claude.ai login or
          to route requests through Free, Pro, or Max plan credentials on behalf of their
          users.&rdquo;
        </blockquote>
      </section>

      <section aria-labelledby="what-is-recorded-h" id="what-is-recorded">
        <h2 id="what-is-recorded-h" className="text-2xl font-semibold text-fg">
          What is recorded
        </h2>
        <p className="mt-3">
          Every room keeps an append-only log on the server&rsquo;s disk. It holds: room
          creation (the working directory and, if supplied, the repository URL); every join
          and leave, with display name; <strong>the full text of every prompt anyone types</strong>,
          together with the author&rsquo;s participant id and display name; every agent
          response; every tool call and its result; every permission request and the decision
          made on it, including who decided; and every interrupt. Each entry carries a
          sequence number and a timestamp.
        </p>
      </section>

      <section
        aria-labelledby="redaction-h"
        id="redaction"
        className="rounded-lg border border-warn/40 bg-surface p-4"
      >
        <h2 id="redaction-h" className="flex items-center gap-2 text-2xl font-semibold text-fg">
          <ShieldAlert size={20} aria-hidden="true" className="text-warn" />
          Redaction is narrow — read this before you type a secret
        </h2>
        <p className="mt-3">
          Before anything is written to the log, Nexus scrubs three specific patterns: an
          Anthropic Console key (<code>sk-ant-…</code>), a GitHub access token in any of its
          current prefixes (<code>ghp_</code>, <code>gho_</code>, <code>ghu_</code>,{' '}
          <code>ghs_</code>, <code>ghr_</code>, <code>github_pat_…</code>), and a credential
          embedded in a URL (<code>https://user:pass@host</code>). Tool output is also cut off
          at 4,000 characters. That is the entire list.
        </p>
        <p className="mt-3 font-semibold text-fg">
          A password, a different service&rsquo;s access token, a customer&rsquo;s name, or any
          other secret typed into a prompt is written to the log verbatim. Nothing scans for
          it and nothing removes it. Do not type a secret into a Nexus room unless you would
          be comfortable with it appearing in the room&rsquo;s permanent log.
        </p>
      </section>

      <section aria-labelledby="also-on-disk-h" id="also-on-disk">
        <h2 id="also-on-disk-h" className="text-2xl font-semibold text-fg">
          Also on disk
        </h2>
        <p className="mt-3">
          Alongside the log, each room has a small metadata file holding the room&rsquo;s own
          access token <strong>in plaintext</strong>, along with the room id, working
          directory and repository URL. Anyone with access to the server&rsquo;s filesystem can
          read it.
        </p>
      </section>

      <section
        aria-labelledby="retention-h"
        id="retention"
        className="rounded-lg border border-danger/50 bg-surface p-4"
      >
        <h2 id="retention-h" className="flex items-center gap-2 text-2xl font-semibold text-fg">
          <AlertTriangle size={20} aria-hidden="true" className="text-danger" />
          Retention: there is currently no deletion mechanism
        </h2>
        <p className="mt-3 font-semibold text-fg">
          Nexus has no room expiry, no time-to-live, no delete endpoint, and no export
          endpoint anywhere in its source code. One of the product&rsquo;s own correctness
          rules forbids changing or removing anything already written to a room&rsquo;s log.
          Logs and any cloned repositories persist on the server&rsquo;s storage until an
          operator deletes them directly. If you want a room&rsquo;s data removed, you must
          contact whoever operates the server it runs on — Nexus itself has no button for
          it, at any level.
        </p>
      </section>

      <section aria-labelledby="browser-storage-h" id="browser-storage">
        <h2 id="browser-storage-h" className="text-2xl font-semibold text-fg">
          Stored in your browser
        </h2>
        <p className="mt-3">
          Nexus keeps a resume token per room and display name in your browser&rsquo;s{' '}
          <code>localStorage</code>, so a refresh or reconnect can reclaim your identity in a
          room instead of appearing as a new participant. A future room switcher may also keep
          a list of recently visited rooms, including their access tokens, the same way. None
          of this is transmitted anywhere except back to the Nexus server when you reconnect.
        </p>
        <p className="mt-3 font-semibold text-fg">
          On a shared or public computer, anyone who opens the browser afterwards can use that
          stored data to reopen your rooms. Use your browser&rsquo;s &ldquo;forget this
          site&rdquo; or private-browsing mode on a machine you do not control, and remove a
          room from the switcher (once available) when you are done with it.
        </p>
      </section>

      <section aria-labelledby="the-link-h" id="the-link">
        <h2 id="the-link-h" className="text-2xl font-semibold text-fg">
          The room link is the credential
        </h2>
        <p className="mt-3">
          Anyone who has the room link is a full participant — able to type prompts, run tools
          through the agent, and see everything in the room. It can end up in your browser
          history, in a screenshot, or in any chat you paste it into. Nexus sends no{' '}
          <code>Referer</code> header to external sites from any of its pages, so a link click
          does not leak the token to a site you visit from the room. Treat the link exactly
          like a password.
        </p>
      </section>

      <section aria-labelledby="repo-cloning-h" id="repo-cloning">
        <h2 id="repo-cloning-h" className="text-2xl font-semibold text-fg">
          Repository cloning
        </h2>
        <p className="mt-3">
          If you supply a repository URL when creating a room, the server clones it into that
          room&rsquo;s own working directory. A URL with credentials embedded in it (
          <code>https://user:pass@host/…</code>) is rejected outright, because that URL would
          otherwise be committed — unredacted — into the room&rsquo;s log the moment the room
          is created.
        </p>
      </section>

      <section aria-labelledby="third-parties-h" id="third-parties">
        <h2 id="third-parties-h" className="text-2xl font-semibold text-fg">
          Third parties
        </h2>
        <p className="mt-3">
          Prompts and code context are sent to Anthropic&rsquo;s API, under the room
          creator&rsquo;s own key, and are subject to{' '}
          <a
            href="https://www.anthropic.com/legal/privacy"
            target="_blank"
            rel="noreferrer noopener"
            className="text-info underline underline-offset-2"
          >
            Anthropic&rsquo;s privacy policy
          </a>{' '}
          and{' '}
          <a
            href="https://www.anthropic.com/legal/consumer-terms"
            target="_blank"
            rel="noreferrer noopener"
            className="text-info underline underline-offset-2"
          >
            terms
          </a>
          . This page and the rest of the marketing and legal pages load the Inter typeface
          from Google Fonts, which means your browser makes a request to Google&rsquo;s font
          servers when you visit them — a static asset fetch, not analytics or tracking, but
          a real request to a third party and worth naming plainly. Nexus adds no other
          third-party processor.
        </p>
      </section>

      <section aria-labelledby="contact-h" id="contact">
        <h2 id="contact-h" className="text-2xl font-semibold text-fg">
          Contact and changes
        </h2>
        <p className="mt-3">
          Questions about this policy, or a request that an operator remove your room&rsquo;s
          data, should go to whoever operates the Nexus instance you used — see the
          repository&rsquo;s README for contact details on the project itself. We will update
          this page and change the date above whenever the software&rsquo;s behaviour changes
          in a way that affects it.
        </p>
      </section>
    </LegalLayout>
  );
}
