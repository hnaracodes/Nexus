export function Status(): JSX.Element {
  return (
    <section aria-labelledby="status-heading" className="px-4 py-16 sm:px-6 sm:py-24">
      <div className="mx-auto max-w-3xl">
        <h2 id="status-heading" className="text-2xl font-semibold text-fg sm:text-3xl">
          Where this actually stands
        </h2>
        <p className="mt-4 text-lg leading-relaxed text-fg-muted">
          Nexus has never been deployed publicly. It is self-hostable software you run yourself:
          clone the repository, bring your own Anthropic Console key, and point it at a working
          directory.
        </p>
        <p className="mt-4 text-lg leading-relaxed text-fg-muted">
          The core loop — one live agent, multiple people watching and typing, four-eyes approval
          on tool calls, an append-only event log that survives a restart — is built and covered by
          an automated test suite. What is not yet built: per-room isolation, rate limiting on room
          creation, and a hardened public deployment.
        </p>
        <p className="mt-4 text-lg leading-relaxed text-fg-muted">
          Because it runs locally today, &quot;Open a room&quot; starts a room on the machine you
          are running Nexus on — it is not a hosted service.
        </p>
      </div>
    </section>
  );
}
