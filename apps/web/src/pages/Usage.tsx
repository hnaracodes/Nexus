import {
  AlertTriangle,
  Boxes,
  Download as DownloadIcon,
  KeyRound,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { LegalLayout } from './LegalLayout.js';

const SECTIONS = [
  { id: 'what-it-is', heading: 'What it is' },
  { id: 'three-ways', heading: 'Three ways to run it' },
  { id: 'api-key', heading: 'You need an Anthropic API key' },
  { id: 'in-a-room', heading: 'What to actually do in a room' },
  { id: 'fleet', heading: 'The fleet' },
  { id: 'not-built', heading: "What isn't built yet" },
  { id: 'trouble', heading: 'When it goes wrong' },
];

const RUN_WAYS = [
  {
    name: 'Web',
    start: 'open the link',
    agentRuns: "in the room's container",
    canJoin: 'yes — send the link',
  },
  {
    name: 'Desktop — join',
    start: 'paste a room link into the app',
    agentRuns: 'with whoever is hosting',
    canJoin: 'you are the guest',
  },
  {
    name: 'Desktop — host a folder',
    start: 'pick a folder in the app',
    agentRuns: 'your machine',
    canJoin: 'yes, on your LAN (opt-in)',
  },
] as const;

const TROUBLE = [
  {
    symptom: '"Nexus needs an Anthropic Console API key"',
    cause:
      'You used a Claude Pro/Max login instead of a Console key. It must start with sk-ant-.',
  },
  {
    symptom: '"This room lost its API key when the server restarted"',
    cause: 'Expected — keys are never persisted. Click Re-enter API key.',
  },
  {
    symptom: 'The .dmg or .exe warns before it will open',
    cause: 'Every build is unsigned (see below). Right-click → Open on macOS, More info → Run anyway on Windows.',
  },
  {
    symptom: 'The agent does nothing, then errors',
    cause: 'Usually an invalid API key — the server waits before saying so, which can look like a hang.',
  },
  {
    symptom: 'Desktop app says a room is already hosted',
    cause: 'One process hosts one folder. Quit and reopen the app to host a different one.',
  },
] as const;

/**
 * `/usage`. A web-legible version of USING.md for people who arrived at the
 * marketing site rather than the repo — same LegalLayout shell as /security,
 * /privacy and /terms, because this is reference material to be scanned, not
 * a pitch to be read start to finish. Deliberately does not restate the
 * download-page mechanics (platform detection, live release fetch, the
 * unsigned-build warning) that already live at /download; it links there
 * instead of duplicating a second copy that can drift out of sync.
 */
export function Usage(): JSX.Element {
  return (
    <LegalLayout title="Using SynCode" lastUpdated="2026-09-11" sections={SECTIONS}>
      <section aria-labelledby="what-it-is-h" id="what-it-is">
        <h2 id="what-it-is-h" className="text-2xl font-semibold text-fg">
          What it is
        </h2>
        <p className="mt-3">
          SynCode turns an AI coding session from a process into a room. Several people open one
          link, see the same live agent output, take turns driving, and collectively approve or
          block risky tool calls — against one agent process holding one context window. The
          collaboration is the mechanism; the governance is the product.
        </p>
        <p className="mt-3">
          The room is a real editor: an activity bar, a file explorer, editor tabs, a collapsible
          transcript panel and a status bar. Files are edited collaboratively — two people typing
          in one file merge, with each other&rsquo;s cursors visible by name.
        </p>
      </section>

      <section aria-labelledby="three-ways-h" id="three-ways">
        <h2 id="three-ways-h" className="text-2xl font-semibold text-fg">
          Three ways to run it
        </h2>
        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface text-left">
                <th scope="col" className="px-4 py-3 font-semibold text-fg">
                  Way
                </th>
                <th scope="col" className="px-4 py-3 font-semibold text-fg">
                  How you start
                </th>
                <th scope="col" className="px-4 py-3 font-semibold text-fg">
                  Where the agent runs
                </th>
                <th scope="col" className="px-4 py-3 font-semibold text-fg">
                  Can others join?
                </th>
              </tr>
            </thead>
            <tbody>
              {RUN_WAYS.map((way) => (
                <tr key={way.name} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-medium text-fg">{way.name}</td>
                  <td className="px-4 py-3 text-fg-muted">{way.start}</td>
                  <td className="px-4 py-3 text-fg-muted">{way.agentRuns}</td>
                  <td className="px-4 py-3 text-fg-muted">{way.canJoin}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="mt-4 flex flex-col gap-2 text-fg-muted">
          <li>
            <strong className="text-fg">Show it to someone over the internet</strong> — the web
            version, no install.
          </li>
          <li>
            <strong className="text-fg">Work on real code on your disk</strong>, alone or with
            someone on your network — the desktop app, &ldquo;Open a folder&rdquo;.
          </li>
          <li>
            <strong className="text-fg">Join someone else&rsquo;s session</strong> — the desktop
            app&rsquo;s &ldquo;Join room&rdquo;, or just open their link in a browser.
          </li>
        </ul>
        <a
          href="/download"
          className="mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-md border border-border-strong px-4 py-2 text-sm font-medium text-fg transition-colors duration-150 hover:border-accent/50 hover:bg-surface"
        >
          <DownloadIcon size={16} aria-hidden="true" />
          Get the desktop app
        </a>
      </section>

      <section
        aria-labelledby="api-key-h"
        id="api-key"
        className="rounded-lg border border-border bg-surface p-4"
      >
        <h2 id="api-key-h" className="flex items-center gap-2 text-2xl font-semibold text-fg">
          <KeyRound size={20} aria-hidden="true" className="text-info" />
          You need an Anthropic API key
        </h2>
        <p className="mt-3">
          Every path needs a real key beginning with <code>sk-ant-</code>, from{' '}
          <a
            href="https://console.anthropic.com"
            target="_blank"
            rel="noreferrer noopener"
            className="text-info underline underline-offset-2"
          >
            console.anthropic.com
          </a>
          . A Claude Pro or Max subscription will not work — those are not API credentials, and
          SynCode rejects the key with a message saying so.
        </p>
        <p className="mt-3">
          The key is held in memory on whichever server runs the room, is used only to construct
          the SDK client, and is never logged, sent to another client, or put in a URL. It is
          never persisted, which is why a room asks for it again after a restart.
        </p>
      </section>

      <section aria-labelledby="in-a-room-h" id="in-a-room">
        <h2 id="in-a-room-h" className="text-2xl font-semibold text-fg">
          What to actually do in a room
        </h2>
        <ol className="mt-3 flex flex-col gap-3">
          <li>
            <strong className="text-fg">Create a room.</strong> Paste your <code>sk-ant-</code>{' '}
            key. Optionally give it a public git repo URL to clone — otherwise the agent gets an
            empty directory.
          </li>
          <li>
            <strong className="text-fg">Copy the link and open it in a second browser</strong>{' '}
            (or send it to someone, or paste it into the desktop app). Both of you are now
            watching the same agent — this is the product; everything else is support structure.
          </li>
          <li>
            <strong className="text-fg">Type a prompt.</strong> Everyone sees it, tagged with who
            sent it.
          </li>
          <li>
            <strong className="text-fg">Ask it to do something risky</strong> — &ldquo;delete
            every file in this directory&rdquo;. The agent suspends and an approval card appears
            for everyone, not just whoever asked. That is the four-eyes gate.
          </li>
          <li>
            <strong className="text-fg">Edit a file in the editor.</strong> Anyone else in the
            room sees your cursor with your name on it, and the change is flushed to the real
            file on disk.
          </li>
          <li>
            <strong className="text-fg">Press Stop mid-turn.</strong> Queued prompts are
            discarded and said so in the log.
          </li>
        </ol>
      </section>

      <section aria-labelledby="fleet-h" id="fleet">
        <h2 id="fleet-h" className="flex items-center gap-2 text-2xl font-semibold text-fg">
          <Boxes size={20} aria-hidden="true" className="text-fg-muted" />
          The fleet
        </h2>
        <p className="mt-3">
          Click the Fleet icon in the activity bar to add agents. Each is its own live session
          with its own transcript; a prompt addressed to one is answered by that one. Only the
          driver can change the fleet, and every agent is told who its siblings are by id at the
          start of each turn.
        </p>
        <p className="mt-3">
          <strong className="text-fg">Crews</strong> are saved sets of agents launched together
          from saved configs (Fleet → configs). A crew naming a config that does not exist fails
          with a sentence you can act on.
        </p>
        <p className="mt-4 flex items-start gap-2 text-fg-muted">
          <Users size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          Refresh the page and everything replays from the log — same room, same history, same
          identity. Ask the agent to read <code>~/.ssh/id_rsa</code> and it is refused without an
          approval card, because the room cannot vote its way outside its own directory.
        </p>
      </section>

      <section
        aria-labelledby="not-built-h"
        id="not-built"
        className="rounded-lg border border-warn/40 bg-surface p-4"
      >
        <h2 id="not-built-h" className="flex items-center gap-2 text-2xl font-semibold text-fg">
          <ShieldAlert size={20} aria-hidden="true" className="text-warn" />
          What isn&rsquo;t built yet
        </h2>
        <ul className="mt-3 flex flex-col gap-2 text-fg-muted">
          <li>Every desktop build is unsigned — see /download for exactly what that means.</li>
          <li>
            A desktop-hosted room is LAN-only. There is no tunnel or relay, so someone on another
            network can&rsquo;t join a room your app is hosting — use the web deployment for
            that.
          </li>
          <li>
            The agent runs where the room runs. Joining a hosted room from the desktop app does
            not move the agent onto your machine.
          </li>
          <li>No accounts. Anyone with a room link is fully inside that room.</li>
          <li>
            No isolation between rooms on a shared server — one host process, one filesystem.
            Invite people you trust; this is not multi-tenant.
          </li>
          <li>
            <code>run_command</code> is bounded, not sealed: the sandbox refuses paths outside
            the room and literal sensitive names, but it is never auto-approved — the room votes
            on every one.
          </li>
        </ul>
      </section>

      <section aria-labelledby="trouble-h" id="trouble">
        <h2 id="trouble-h" className="flex items-center gap-2 text-2xl font-semibold text-fg">
          <AlertTriangle size={20} aria-hidden="true" className="text-fg-muted" />
          When it goes wrong
        </h2>
        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[480px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface text-left">
                <th scope="col" className="px-4 py-3 font-semibold text-fg">
                  Symptom
                </th>
                <th scope="col" className="px-4 py-3 font-semibold text-fg">
                  Cause
                </th>
              </tr>
            </thead>
            <tbody>
              {TROUBLE.map((row) => (
                <tr key={row.symptom} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-medium text-fg">{row.symptom}</td>
                  <td className="px-4 py-3 text-fg-muted">{row.cause}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </LegalLayout>
  );
}
