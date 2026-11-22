import type { SynCodeEvent } from '@syncode/protocol/events';

const ROOM = 'room_fixture';
const ts = (seq: number): string => new Date(2026, 6, 28, 0, 0, seq).toISOString();

export function prompt(
  seq: number,
  participantId: string,
  displayName: string,
  text: string,
): SynCodeEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'user_prompt',
    participantId,
    displayName,
    text,
  } as SynCodeEvent;
}

export function interrupted(seq: number, displayName: string, agentId?: string): SynCodeEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'interrupted',
    participantId: `p_${displayName}`,
    displayName,
    ...(agentId ? { agentId } : {}),
  } as SynCodeEvent;
}

export function delivered(seq: number, promptSeqs: number[], agentId?: string): SynCodeEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'prompt_batch_delivered',
    promptSeqs,
    driverId: null,
    ...(agentId ? { agentId } : {}),
  } as SynCodeEvent;
}

export function discarded(
  seq: number,
  promptSeqs: number[],
  byDisplayName: string,
  agentId?: string,
): SynCodeEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'prompt_batch_discarded',
    promptSeqs,
    byParticipantId: `p_${byDisplayName}`,
    byDisplayName,
    ...(agentId ? { agentId } : {}),
  } as SynCodeEvent;
}
