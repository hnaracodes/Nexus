import type { SynCodeEvent } from '@syncode/protocol/events';

export interface AutoModeState {
  participantId: string;
  displayName: string;
}

/**
 * Who has auto mode on (phase 19a), or null when it is off — derived from the
 * log, never stored beside it (I3). The last `auto_mode_changed` wins,
 * including the server's own `reason: 'server_restart'` switch-off, so a
 * rejoining client and a live one always agree with what the gate is doing.
 */
export function deriveAutoMode(events: readonly SynCodeEvent[]): AutoModeState | null {
  let state: AutoModeState | null = null;
  for (const event of events) {
    if (event.type !== 'auto_mode_changed') continue;
    state =
      event.enabled && event.participantId !== null
        ? { participantId: event.participantId, displayName: event.displayName ?? event.participantId }
        : null;
  }
  return state;
}
