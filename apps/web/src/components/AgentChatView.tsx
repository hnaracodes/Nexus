import { PRIMARY_AGENT_ID } from '@syncode/protocol/events';
import type { AgentId, SynCodeEvent } from '@syncode/protocol/events';
import type { FleetEntry } from '@syncode/protocol/wire';
import { deriveLatestPublishedPr } from '../publishedPr.js';
import { AgentPicker } from './AgentPicker.js';
import { DriverRequestNotice } from './DriverRequestNotice.js';
import { InterruptNotice } from './InterruptNotice.js';
import { MessageList } from './MessageList.js';
import { PendingPrompts } from './PendingPrompts.js';
import { PromptDock } from './PromptDock.js';
import { PublishedPrCard } from './PublishedPr.js';

export interface AgentChatViewProps {
  roomId: string;
  token: string;
  /** Every room event — notices and the dock derive from the full log (I3). */
  events: SynCodeEvent[];
  /** The transcript for the focused agent (already filtered by the shell). */
  focusedEvents: SynCodeEvent[];
  pendingDeltas: Record<string, string>;
  replaying: boolean;
  fleet: FleetEntry[];
  focusedAgentId: AgentId | null;
  onFocusAgent: (agentId: AgentId | null) => void;
  driverId: string | null;
  selfId: string | null;
  /** Connection state ONLY (I2'). Never derive this from the driver token. */
  promptDisabled: boolean;
  promptValue: string;
  onPromptChange: (value: string) => void;
  onSubmitPrompt: (text: string) => void;
  onStop: () => void;
  onSetModel: (model: string | null) => void;
  onResendPrompt: (text: string) => void;
  onGrantControl: (participantId: string) => void;
  dismissedDriverRequests: Set<string>;
  onDismissDriverRequest: (participantId: string) => void;
  /** Pending approvals in the room. While > 0 a strip pins to the top. */
  approvalCount: number;
  onReviewApprovals: () => void;
}

/**
 * The aux bar's Chat view: the transcript and the prompt dock, moved here
 * from the old bottom panel in the same order they had there.
 *
 * The pending-approvals strip is the load-bearing addition. Approvals live in
 * the other aux view, so someone reading Chat could otherwise miss that an
 * agent is blocked on them. The strip has no dismiss control on purpose: it
 * goes away only when the count reaches zero.
 */
export function AgentChatView(props: AgentChatViewProps): JSX.Element {
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-2 p-2">
      {props.approvalCount > 0 && (
        <div
          role="status"
          className="flex shrink-0 items-center justify-between gap-2 rounded border border-warn bg-warn/10 px-3 py-2 text-xs text-fg"
        >
          <span>
            {props.approvalCount} {props.approvalCount === 1 ? 'approval' : 'approvals'} pending
          </span>
          <button
            type="button"
            onClick={props.onReviewApprovals}
            className="rounded-sm bg-accent px-2 py-1 font-medium text-on-accent hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:ring-offset-surface focus-visible:ring-accent"
          >
            Review
          </button>
        </div>
      )}

      <AgentPicker fleet={props.fleet} focusedAgentId={props.focusedAgentId} onFocusAgent={props.onFocusAgent} />

      <PublishedPrCard
        pr={deriveLatestPublishedPr(props.events)}
        selfId={props.selfId}
        replaying={props.replaying}
      />

      <DriverRequestNotice
        events={props.events}
        selfId={props.selfId}
        driverId={props.driverId}
        onGrant={props.onGrantControl}
        onDismiss={props.onDismissDriverRequest}
        dismissedParticipantIds={props.dismissedDriverRequests}
      />

      <div className="min-h-0 flex-1">
        <MessageList events={props.focusedEvents} pendingDeltas={props.pendingDeltas} />
      </div>

      {/*
        The input is gated on connection state only, never on the driver token —
        that is the point of I2'. Anyone may speak; the server orders, attributes
        and batches, and the agent resolves genuine conflicts in the driver's
        favour. Adding a driver check here would undo the feature.
      */}
      {/* --- BEGIN phase-3b stop-button slot --- */}
      <InterruptNotice events={props.events} focusedAgentId={props.focusedAgentId ?? PRIMARY_AGENT_ID} />
      <PendingPrompts
        events={props.events}
        onResend={props.onResendPrompt}
        onEdit={props.onPromptChange}
        {...(props.selfId === null ? {} : { selfId: props.selfId })}
        onSendNow={(texts) => {
          // Stop first: the server discards the queued batch before it
          // interrupts, so the resend lands as a fresh prompt for the next
          // turn instead of being thrown away with the old batch.
          props.onStop();
          for (const text of texts) props.onResendPrompt(text);
        }}
      />
      <PromptDock
        roomId={props.roomId}
        token={props.token}
        events={props.events}
        driverId={props.driverId}
        selfId={props.selfId}
        promptDisabled={props.promptDisabled}
        promptValue={props.promptValue}
        onPromptChange={props.onPromptChange}
        onSubmitPrompt={props.onSubmitPrompt}
        onStop={props.onStop}
        stopBusy={false}
        onSetModel={props.onSetModel}
      />
      {/* --- END phase-3b stop-button slot --- */}
    </div>
  );
}
