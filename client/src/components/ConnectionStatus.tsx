import type { Status } from '../ws.js';

const LABEL: Record<Status, string> = {
  connecting: 'Connecting…',
  open: 'Connected',
  reconnecting: 'Reconnecting…',
  closed: 'Disconnected',
};

const TONE: Record<Status, string> = {
  connecting: 'bg-amber-100 text-amber-900',
  open: 'bg-emerald-100 text-emerald-900',
  reconnecting: 'bg-amber-100 text-amber-900',
  closed: 'bg-rose-100 text-rose-900',
};

export function ConnectionStatus({ status }: { status: Status }): JSX.Element {
  return <span className={`rounded px-2 py-1 text-xs ${TONE[status]}`}>{LABEL[status]}</span>;
}
