import { useEffect, useRef, useState } from 'react';
import { Crown, ShieldAlert, Check, X } from 'lucide-react';

/**
 * The demo.
 *
 * Everything else on this page *asserts* that SynCode is one agent shared by
 * several people with collective approval. This section shows it: a scripted
 * room that plays the real flow beat by beat, with a caption naming what just
 * happened and why it matters.
 *
 * The beat that carries the whole product is step 4 — a **non-driver** approves
 * the write. If a visitor takes one thing from this page, it should be that
 * approval is a room-wide power and deliberately not the driver's alone.
 *
 * It loops, it pauses on hover or focus, and under `prefers-reduced-motion` it
 * renders every step at once as a static storyboard instead of animating.
 */

interface Beat {
  label: string;
  caption: string;
}

const BEATS: Beat[] = [
  {
    label: 'Anyone types',
    caption:
      'Marcus is not driving. He can still send a prompt — the server admits it, orders it, and attributes it to him. Nothing is silently dropped.',
  },
  {
    label: 'One agent answers',
    caption:
      'One process, one context window. Priya did not re-explain anything: the agent already has Marcus’s request and the whole history.',
  },
  {
    label: 'A risky call pauses',
    caption:
      'Writes are not auto-approved. The agent suspends mid-turn and shows the room the exact diff it wants to apply, before it applies it.',
  },
  {
    label: 'A non-driver approves',
    caption:
      'Marcus approves — and he is not the driver. Governance is a room-wide power, not a privilege of whoever holds the token. First response wins.',
  },
  {
    label: 'It lands, on the record',
    caption:
      'The write executes and every step — who prompted, who approved, what changed — is appended to a log the room can replay.',
  },
];

const STEP_MS = 3400;

function Avatar({ initial, hue }: { initial: string; hue: number }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: `hsl(${hue} 55% 45%)` }}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
    >
      {initial}
    </span>
  );
}

export function LiveDemo(): JSX.Element {
  const reduced =
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (reduced || paused) return undefined;
    timer.current = setInterval(() => setStep((s) => (s + 1) % BEATS.length), STEP_MS);
    return () => {
      if (timer.current !== null) clearInterval(timer.current);
    };
  }, [reduced, paused]);

  // Under reduced motion everything is simply shown.
  const at = (n: number): boolean => reduced || step >= n;

  return (
    <section id="demo" className="border-t border-border px-6 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <p className="mb-2 font-mono text-xs text-accent">Watch it happen</p>
        <h2 className="mb-3 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
          One room, one agent, two people deciding together.
        </h2>
        <p className="mb-10 max-w-prose text-fg-muted">
          This is the actual sequence, in order. The only thing missing is the part
          where you and a teammate are both looking at it.
        </p>

        <div
          className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocusCapture={() => setPaused(true)}
          onBlurCapture={() => setPaused(false)}
        >
          {/* Steps. Buttons, not decoration — a reader who wants to dwell on the
              approval beat can click straight to it. */}
          <ol className="flex flex-col gap-1.5">
            {BEATS.map((beat, index) => {
              const active = index === step;
              return (
                <li key={beat.label}>
                  <button
                    type="button"
                    onClick={() => setStep(index)}
                    aria-current={active ? 'step' : undefined}
                    className={`w-full rounded-lg border p-4 text-left transition-colors duration-200 ${
                      active
                        ? 'border-accent/50 bg-accent/10'
                        : 'border-border bg-surface hover:border-border-strong'
                    }`}
                  >
                    <span className="flex items-baseline gap-3">
                      <span
                        className={`font-mono text-xs ${active ? 'text-accent' : 'text-fg-muted'}`}
                      >
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span
                        className={`text-sm font-semibold ${active ? 'text-fg' : 'text-fg-muted'}`}
                      >
                        {beat.label}
                      </span>
                    </span>
                    {(active || reduced) && (
                      <span className="mt-2 block pl-8 text-sm leading-relaxed text-fg-muted">
                        {beat.caption}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>

          {/* The room. Captioned as an illustration and aria-hidden: it is an
              illustration of the product, not live data, and a screen reader
              gets the story from the step list beside it. */}
          <figure className="m-0">
            <div
              aria-hidden="true"
              className="overflow-hidden rounded-lg border border-border bg-surface"
            >
              <div className="flex items-center justify-between border-b border-border bg-surface-2/50 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="flex gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full bg-danger/70" />
                    <span className="h-2.5 w-2.5 rounded-full bg-warn/70" />
                    <span className="h-2.5 w-2.5 rounded-full bg-success/70" />
                  </span>
                  <Avatar initial="P" hue={52} />
                  <Avatar initial="M" hue={190} />
                  <span className="ml-1 font-mono text-[11px] text-fg-muted">payments-api</span>
                </div>
                <span className="flex items-center gap-1 rounded-full bg-accent/12 px-2 py-0.5 text-[11px] text-accent">
                  <Crown size={11} aria-hidden="true" /> Priya is driving
                </span>
              </div>

              <div className="flex min-h-[330px] flex-col gap-2 p-3 text-[13px]">
                <div className="demo-in flex items-start gap-2">
                  <Avatar initial="M" hue={190} />
                  <p className="text-fg">
                    <span className="font-semibold">Marcus</span>{' '}
                    <span className="text-fg-muted">
                      the retry on <code className="font-mono text-accent">fetchInvoice</code> is
                      missing — can you add one?
                    </span>
                  </p>
                </div>

                {at(1) && (
                  <div className="demo-in rounded-lg border border-border/70 bg-bg px-3 py-2">
                    <p className="mb-1 font-mono text-[11px] text-fg-muted">agent</p>
                    <p className="text-fg">
                      I’ll wrap it in the existing <code className="font-mono text-accent">retry</code>{' '}
                      helper and keep the timeout at 5s.
                    </p>
                  </div>
                )}

                {at(2) && (
                  <div
                    className={`demo-in rounded-lg border p-2.5 ${
                      at(3) ? 'border-border' : 'border-warn/60 bg-warn/8'
                    }`}
                  >
                    <p className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-warn">
                      <ShieldAlert size={13} aria-hidden="true" />
                      Permission requested — Edit
                    </p>
                    <pre className="mb-2 overflow-x-auto rounded border border-border bg-bg p-2 font-mono text-[11px] leading-relaxed">
                      <code>
                        <span className="text-fg-muted"> src/invoice.ts</span>
                        {'\n'}
                        <span className="text-danger">- const r = await fetch(url)</span>
                        {'\n'}
                        <span className="text-success">+ const r = await retry(() =&gt; fetch(url))</span>
                      </code>
                    </pre>
                    {at(3) ? (
                      <p className="flex items-center gap-1.5 text-[12px] text-success">
                        <Check size={13} aria-hidden="true" />
                        Approved by <span className="font-semibold">Marcus</span> — not the driver
                      </p>
                    ) : (
                      <div className="flex gap-2">
                        <span className="rounded-md bg-success/15 px-2.5 py-1 text-[12px] font-medium text-success">
                          Approve
                        </span>
                        <span className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[12px] text-fg-muted">
                          <X size={11} aria-hidden="true" /> Deny
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {at(4) && (
                  <div className="demo-in flex items-center gap-2 rounded-lg border border-border/70 bg-bg px-3 py-2 text-[12px] text-fg-muted">
                    <Check size={13} className="text-success" aria-hidden="true" />
                    <span>
                      Wrote <code className="font-mono text-fg">src/invoice.ts</code> · logged at
                      seq 41
                    </span>
                  </div>
                )}
              </div>
            </div>
            <figcaption className="mt-3 text-center text-xs text-fg-muted">
              {/* Deliberately not the word "mockup": the hero's RoomMock owns
                  that label and a landing test asserts there is exactly one. */}
              An illustration of a SynCode room — not live data.
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}
