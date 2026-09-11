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
 * Composes the prompt box with the four pieces of session chrome a
 * Cursor-like room needs: which repo/branch the room targets, how much
 * context is left, which model is answering, and a voice-input affordance.
 *
 * Composition only (docs/plans/phase-7c-prompt-dock.md). `PromptInput` and
 * `StopButton` are read-only here — their controlled/uncontrolled contract
 * and existing tests are untouched. This component owns none of their
 * internals, only the layout around them.
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
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <RepoBranchBar events={events} roomId={roomId} />
        <ContextWindowBar events={events} />
        <ModelSelector
          roomId={roomId}
          token={token}
          events={events}
          driverId={driverId}
          selfId={selfId}
          onSetModel={onSetModel}
        />
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <PromptInput
            disabled={promptDisabled}
            value={promptValue}
            onChange={onPromptChange}
            onSubmit={onSubmitPrompt}
          />
        </div>
        <VoiceInputButton
          onTranscript={(text) =>
            onPromptChange(promptValue.length > 0 ? `${promptValue} ${text}` : text)
          }
        />
        <StopButton busy={stopBusy} onStop={onStop} />
      </div>
    </div>
  );
}
