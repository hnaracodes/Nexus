import { Bot, Crown, Files, GitBranch, MessageSquare, Search, ShieldAlert, User } from 'lucide-react';
import { AVATAR_HUES } from '../../design/tokens.js';

/**
 * A static, non-interactive replica of the room UI, built from the real
 * token set and laid out like the real shell: files on the left, editor tabs
 * in the middle, agent buttons on a right-hand activity bar, and an
 * accent-coloured status bar underneath. It never animates and never implies
 * live data — every value here is fixed prose, not a stream. aria-hidden
 * because it is decorative; the equivalent information is in the surrounding
 * section copy, and the visually-hidden caption alongside it names it a
 * mockup for anyone using a screen reader.
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
        className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-bg"
      >
        {/* title bar */}
        <div className="flex items-center gap-2 bg-titlebar px-3 py-1.5">
          <span className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-danger/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-warn/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-success/70" />
          </span>
          <span className="ml-1 font-mono text-[11px] text-fg-muted">room/payments-api</span>
          <div className="ml-auto flex -space-x-1.5">
            {participants.map((p) => (
              <span
                key={p.name}
                className="flex h-5 w-5 items-center justify-center rounded-full border border-titlebar text-[10px] font-medium text-white"
                style={{ backgroundColor: `hsl(${p.hue}, 70%, 42%)` }}
              >
                {p.name[0]}
              </span>
            ))}
          </div>
        </div>

        <div className="flex">
          {/* left activity bar + side bar */}
          <div className="flex w-8 shrink-0 flex-col items-center gap-3 bg-activity py-2 text-activity-fg">
            <Files size={14} className="text-activity-fg-active" />
            <Search size={14} />
            <GitBranch size={14} />
          </div>
          <div className="hidden w-28 shrink-0 bg-surface px-2 py-2 font-mono text-[11px] text-fg-muted sm:block">
            <p className="mb-1 text-[10px] uppercase tracking-wide">Explorer</p>
            <p>src</p>
            <p className="pl-2 text-fg">retry.ts</p>
            <p className="pl-2">client.ts</p>
            <p>README.md</p>
          </div>

          {/* editor column */}
          <div className="min-w-0 flex-1">
            <div className="flex bg-tab-strip text-[11px]">
              <span className="border-t border-t-accent bg-tab-active px-3 py-1.5 text-fg">retry.ts</span>
              <span className="bg-tab-inactive px-3 py-1.5 text-fg-muted">client.ts</span>
            </div>
            <pre className="overflow-hidden bg-bg px-3 py-2 font-mono text-[11px] leading-5 text-fg">
              <span className="text-accent-3">export</span> async <span className="text-accent-3">function</span> retry(fn) {'{'}
              {'\n'}
              {'  '}
              <span className="text-accent-2">return</span> fn();
              {'\n'}
              {'}'}
            </pre>
            <div className="space-y-2 border-t border-border bg-surface px-3 py-2">
              <div className="flex gap-2 text-xs">
                <span className="shrink-0 font-medium text-fg-muted">Marcus</span>
                <p className="text-fg-muted">can you add a retry to the fetch call?</p>
              </div>
              <div className="rounded-md bg-surface-2 p-2 text-xs text-fg">
                <p className="mb-1 flex items-center gap-1 font-medium text-fg-muted">
                  <User size={12} />
                  agent
                </p>
                <p>I&apos;ll wrap the request in a retry helper and run the test suite.</p>
              </div>
              <div className="rounded-md border border-warn bg-surface-2 p-2">
                <p className="mb-1 flex items-center gap-1 text-xs font-medium text-warn">
                  <ShieldAlert size={12} />
                  Permission requested — Bash
                </p>
                <p className="mb-2 rounded bg-bg px-2 py-1 font-mono text-[11px] text-fg-muted">
                  npm test
                </p>
                <div className="flex gap-2 text-[11px]">
                  <span className="rounded bg-accent px-2 py-1 font-medium text-on-accent">Approve</span>
                  <span className="rounded bg-muted px-2 py-1 font-medium text-fg-muted">Deny</span>
                </div>
              </div>
            </div>
          </div>

          {/* right activity bar: the agent buttons */}
          <div className="flex w-8 shrink-0 flex-col items-center gap-3 bg-activity py-2 text-activity-fg">
            <MessageSquare size={14} className="text-activity-fg-active" />
            <ShieldAlert size={14} />
            <Bot size={14} />
          </div>
        </div>

        {/* status bar */}
        <div className="flex items-center justify-between bg-status px-3 py-0.5 text-[11px] text-status-fg">
          <span className="flex items-center gap-1">
            <GitBranch size={11} />
            main
          </span>
          <span className="flex items-center gap-1">
            <Crown size={11} />
            Priya is driving
          </span>
        </div>
      </div>
    </div>
  );
}
