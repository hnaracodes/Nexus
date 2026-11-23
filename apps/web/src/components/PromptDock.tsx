import type { SynCodeEvent } from '@syncode/protocol/events';
import { ContextWindowBar } from './ContextWindowBar.js';
import { ModelSelector } from './ModelSelector.js';
import { PromptInput } from './PromptInput.js';
import { RepoBranchBar } from './RepoBranchBar.js';
import { StopButton } from './StopButton.js';
import { VoiceInputButton } from './VoiceInputButton.js';

export interface PromptDockProps {
  roomId: string;
  token: string;
  events: SynCodeEvent[];
  driverId: string | null;
  selfId: string | null;
  promptDisabled: boolean;
  promptValue: string;
  onPromptChange: (value: string) => void;
  onSubmitPrompt: (text: string) => void;
  onStop: () => void;
  stopBusy: boolean;
  onSetModel: (model: string | null) => void;
}

/**
 * Composes ONE bordered input box (VS Code chat style): the textarea over a
 * compact toolbar of model selector, repo/branch and context-usage chips
 * (left, they truncate when narrow), then mic, Stop and Send (right).
 * Composition only: it owns the arrangement, not the pieces' internals.
 *
 * I2' — `promptDisabled` must be driven from connection state only (see
 * App.tsx:110-115), never from `driverId`. The one deliberate exception is
 * `ModelSelector`, which gates itself internally.
 */
export function PromptDock({
  roomId,
  token,
  events,
  driverId,
  selfId,
  promptDisabled,
  promptValue,
  onPromptChange,
  onSubmitPrompt,
  onStop,
  stopBusy,
  onSetModel,
}: PromptDockProps): JSX.Element {
  return (
    <PromptInput
      disabled={promptDisabled}
      value={promptValue}
      onChange={onPromptChange}
      onSubmit={onSubmitPrompt}
      toolbar={
        <>
          <ModelSelector
            roomId={roomId}
            token={token}
            events={events}
            driverId={driverId}
            selfId={selfId}
            onSetModel={onSetModel}
          />
          <RepoBranchBar events={events} roomId={roomId} />
          <ContextWindowBar events={events} />
        </>
      }
      actions={
        <>
          <VoiceInputButton
            onTranscript={(text) =>
              onPromptChange(promptValue.length > 0 ? `${promptValue} ${text}` : text)
            }
          />
          <StopButton busy={stopBusy} onStop={onStop} />
        </>
      }
    />
  );
}
