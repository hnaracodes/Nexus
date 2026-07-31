import { ShieldAlert } from 'lucide-react';

export function SecurityHonesty(): JSX.Element {
  return (
    <section
      aria-labelledby="security-honesty-heading"
      className="border-y border-warn/40 bg-surface px-4 py-16 sm:px-6 sm:py-24"
    >
      <div className="mx-auto max-w-3xl text-center">
        <ShieldAlert size={32} className="mx-auto text-warn" aria-hidden="true" />
        <h2 id="security-honesty-heading" className="mt-4 text-2xl font-semibold text-fg sm:text-3xl">
          A shared room is a shared security boundary.
        </h2>
        <p className="mt-4 text-lg leading-relaxed text-fg-muted">
          Whatever the room can do, every participant can do — read <code>.env</code>, use your
          git credentials, run commands. Rooms are invite-only-among-people-you-trust, not public.
        </p>
        <p className="mt-6 text-xl font-semibold text-fg">
          The MVP has no isolation between rooms.
        </p>
        <p className="mt-4 text-lg leading-relaxed text-fg-muted">
          One host process, one filesystem — room A can in principle reach room B&apos;s working
          directory.
        </p>
        <a
          href="/security"
          className="mt-8 inline-flex min-h-[44px] items-center rounded-md border border-border px-6 py-3 text-base font-medium text-fg transition-colors duration-150 hover:bg-surface-2"
        >
          Read the full security model
        </a>
      </div>
    </section>
  );
}
