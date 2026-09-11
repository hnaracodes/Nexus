import { Crown, ShieldAlert, User } from 'lucide-react';
import { AVATAR_HUES } from '../../design/tokens.js';

/**
 * A static, non-interactive replica of the room UI, built from the real
 * token set. It never animates and never implies live data — every value
 * here is fixed prose, not a stream. aria-hidden because it is decorative;
 * the equivalent information is in the surrounding section copy, and the
 * visually-hidden caption alongside it names it a mockup for anyone using
 * a screen reader.
 */
export function RoomMock(): JSX.Element {
  const participants = [
    { name: 'Priya', hue: AVATAR_HUES[0], driver: true },
    { name: 'Marcus', hue: AVATAR_HUES[3], driver: false },
    { name: 'Dana', hue: AVATAR_HUES[6], driver: false },
  ];

  return (
    <div>
      <span className="sr-only">Mockup of a SynCode room — not a live view.</span>
      <div
        aria-hidden="true"
        className="w-full max-w-md overflow-hidden rounded-lg border border-border bg-surface"
      >
        <div className="flex items-center gap-2 border-b border-border bg-surface-2/40 px-3 py-2">
          <span className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-danger/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-warn/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-success/70" />
          </span>
          <span className="ml-1 font-mono text-[11px] text-fg-muted">room/payments-api</span>
        </div>

        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex -space-x-2">
            {participants.map((p) => (
              <span
                key={p.name}
                className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-surface text-xs font-medium text-white"
                style={{ backgroundColor: `hsl(${p.hue}, 70%, 42%)` }}
              >
                {p.name[0]}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded-md bg-accent-dim px-2 py-1 text-xs font-medium text-fg">
            <Crown size={14} className="text-accent" />
            Priya is driving
          </div>
        </div>

        <div className="space-y-3 px-4 py-4">
          <div className="flex gap-2 text-sm">
            <span className="shrink-0 font-medium text-fg-muted">Marcus</span>
            <p className="text-fg-muted">can you add a retry to the fetch call?</p>
          </div>
          <div className="rounded-lg bg-surface-2 p-3 text-sm text-fg">
            <p className="mb-1 flex items-center gap-1 font-medium text-fg-muted">
              <User size={14} />
              agent
            </p>
            <p>I&apos;ll wrap the request in a retry helper and run the test suite.</p>
          </div>

          <div className="rounded-lg border border-warn bg-surface-2 p-3">
            <p className="mb-1 flex items-center gap-1 text-sm font-medium text-warn">
              <ShieldAlert size={14} />
              Permission requested — Bash
            </p>
            <p className="mb-2 rounded bg-bg px-2 py-1 font-mono text-xs text-fg-muted">
              npm test
            </p>
            <div className="flex gap-2 text-xs">
              <span className="rounded bg-accent-dim px-2 py-1 font-medium text-fg">
                Approve
              </span>
              <span className="rounded bg-surface px-2 py-1 font-medium text-fg-muted">Deny</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
