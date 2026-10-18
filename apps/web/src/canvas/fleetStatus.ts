import { AlertOctagon, Circle, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import type { AgentProvider } from '@syncode/protocol/events';
import type { AgentStatus, FleetEntry } from '@syncode/protocol/wire';

/**
 * The one status table shared by the fleet strip and the fleet pane.
 * `awaiting_approval` is the loudest state everywhere: it is the state where
 * the fleet is blocked on a human, so it must be findable by TEXT, not colour.
 * (RunOverlay keeps its own table: it adds two states a fleet never has.)
 */
export interface StatusMeta {
  label: string;
  icon: typeof Circle;
  tone: string;
  iconClassName: string;
}

/**
 * WHY `awaiting_approval` has its own icon, its own pulsing animation and its
 * own warn tone (and a heavier row treatment where it renders): it is the one
 * state where the fleet is blocked on a HUMAN. If twelve agents are each
 * waiting for the room and the list looks like twelve idle rows, the
 * four-eyes gate is technically working and practically invisible. It is also
 * carried by TEXT ("Needs approval", with a count), never colour alone.
 * These tables only REPORT the gate; nothing here may act on it or imply
 * consent.
 */
export const STATUS_META: Record<AgentStatus, StatusMeta> = {
  idle: { label: 'Idle', icon: Circle, tone: 'text-fg-muted', iconClassName: '' },
  working: { label: 'Working', icon: Loader2, tone: 'text-accent', iconClassName: 'animate-spin' },
  awaiting_approval: {
    label: 'Needs approval',
    icon: ShieldAlert,
    tone: 'text-warn',
    iconClassName: 'animate-nexus-pulse',
  },
  error: { label: 'Error', icon: AlertOctagon, tone: 'text-danger', iconClassName: '' },
  stopped: { label: 'Stopped', icon: XCircle, tone: 'text-fg-muted', iconClassName: '' },
};

export const PROVIDER_LABEL: Record<AgentProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

export function statusText(agent: Pick<FleetEntry, 'status' | 'pendingApprovals'>): string {
  const meta = STATUS_META[agent.status];
  if (agent.status === 'awaiting_approval' && agent.pendingApprovals > 0) {
    return `${meta.label} · ${agent.pendingApprovals} pending`;
  }
  return meta.label;
}
