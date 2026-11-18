import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ClientFrame } from '@syncode/protocol/wire';
import { COLORS } from '../design/tokens.js';
import type { TerminalHub } from './terminalHub.js';

/**
 * One live terminal on screen (phase 19b): xterm.js, fed by the hub, typing
 * straight back to the server. Every keystroke goes to the SHARED shell — this
 * view holds no state of its own beyond what xterm needs to draw.
 *
 * Keyed by `termId` by its parent, so switching tabs mounts a fresh view that
 * re-attaches and gets the server's scrollback (the hub resets on snapshot).
 */
export function XtermView({
  termId,
  hub,
  send,
}: {
  termId: string;
  hub: TerminalHub;
  send: (frame: ClientFrame) => void;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  // Read through a ref, NOT listed as an effect dependency: callers pass a new
  // closure every render (App re-renders on every room event), and depending
  // on its identity would tear down and rebuild the terminal each time.
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    const send = (frame: ClientFrame): void => sendRef.current(frame);
    const element = host.current;
    if (element === null) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: 12,
      scrollback: 5000,
      theme: {
        background: COLORS.bg,
        foreground: COLORS.fg,
        cursor: COLORS.fg,
        selectionBackground: COLORS.accentDim,
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);

    const sendSize = (): void => {
      try {
        fit.fit();
      } catch {
        return; // not laid out yet (hidden panel)
      }
      send({ kind: 'term_resize', termId, cols: term.cols, rows: term.rows });
    };

    const unsubscribe = hub.subscribe(termId, {
      write: (data, reset) => {
        if (reset) term.reset();
        term.write(data);
      },
      exited: (exitCode) => {
        term.write(`\r\n\x1b[2m[process exited${exitCode === null ? '' : ` with code ${exitCode}`}]\x1b[0m\r\n`);
      },
    });
    send({ kind: 'term_attach', termId });

    const input = term.onData((data) => send({ kind: 'term_input', termId, data }));
    // One PTY, one size: whoever is actively here sets it (plan: "the most
    // recent person to type or resize sets it"). Focusing claims it.
    const focusIn = (): void => sendSize();
    element.addEventListener('focusin', focusIn);
    const observer = new ResizeObserver(() => sendSize());
    observer.observe(element);
    sendSize();
    term.focus();

    return () => {
      observer.disconnect();
      element.removeEventListener('focusin', focusIn);
      input.dispose();
      unsubscribe();
      term.dispose();
    };
  }, [termId, hub]);

  return <div ref={host} className="h-full w-full overflow-hidden px-2 py-1" />;
}
