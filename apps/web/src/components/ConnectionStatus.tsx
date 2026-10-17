import { Wifi, WifiOff } from 'lucide-react';
import type { Status } from '../ws.js';

const LABEL: Record<Status, string> = {
  connecting: 'Connecting…',
  open: 'Connected',
  reconnecting: 'Reconnecting…',
  closed: 'Disconnected',
};

const TONE: Record<Status, string> = {
  connecting: 'border-warn text-warn',
  open: 'border-accent text-accent-fg',
  reconnecting: 'border-warn text-warn',
  closed: 'border-danger text-danger',
};

/**
 * A token-coloured connection indicator. Colour never carries the meaning
 * alone — the icon (Wifi live, WifiOff otherwise) and the text label both
 * restate it.
 *
 * `variant="inline"` drops the pill and inherits the surrounding text colour,
 * for the status bar, where the bar itself changes colour when disconnected.
 */
export function ConnectionStatus({
  status,
  retrySecondsLeft,
  variant = 'pill',
}: {
  status: Status;
  /**
   * Seconds until the next reconnect attempt (backoff table at ws.ts:31).
   * Optional and additive — existing callers passing only `status` keep
   * working; the integration pass wires this once `connect()` exposes it.
   */
  retrySecondsLeft?: number;
  variant?: 'pill' | 'inline';
}): JSX.Element {
  const Icon = status === 'open' || status === 'connecting' ? Wifi : WifiOff;
  const suffix =
    status === 'reconnecting' && retrySecondsLeft !== undefined && retrySecondsLeft > 0
      ? ` · retrying in ${retrySecondsLeft}s`
      : '';

  return (
    <span
      role="status"
      className={
        variant === 'inline'
          ? 'inline-flex items-center gap-1.5'
          : `inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${TONE[status]}`
      }
    >
      <Icon size={variant === 'inline' ? 12 : 16} aria-hidden="true" />
      {LABEL[status]}
      {suffix}
    </span>
  );
}
