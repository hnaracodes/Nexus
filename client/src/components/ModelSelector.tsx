import { useEffect, useState } from 'react';
import { Cpu } from 'lucide-react';
import type { NexusEvent } from '../../../src/protocol/events.js';

/** The default-model sentinel used by the `<select>`. `null` is not a valid HTML option value. */
const DEFAULT_OPTION_VALUE = '__default__';

/**
 * Mirrors the SDK's `ModelInfo` (`coreTypes.d.ts:310-317`) rather than
 * importing it: this is a client-side HTTP response shape, not a protocol
 * type, and `src/server/` is out of bounds for this file. `GET
 * /api/rooms/:id/models`.
 *
 * RECONCILED against the landed handler (`src/server/index.ts`): it returns
 * `{ models: await runtime.agent.listModels() }`, and `listModels()` passes the
 * SDK's `ModelInfo` through verbatim — `{value, displayName, description}`
 * (`coreTypes.d.ts:310-317`). The shape below matches field for field. It is
 * declared here rather than imported because this is an HTTP response shape,
 * not a protocol type, and `src/server/` is out of bounds for a client module.
 */
interface ModelOption {
  value: string;
  displayName: string;
  description: string;
}

/**
 * Lets a participant switch the room's model without restarting the agent
 * (I1 — one room, one `query()` for its lifetime; `setModel` mutates the
 * running session rather than spawning a new one).
 *
 * The disabled-while-a-driver-exists rule below is a COURTESY, not the
 * enforcement. The real gate is server-side: 7a rejects a non-driver's
 * `set_model` frame in `index.ts` regardless of what this control shows. Do
 * not remove that server check on the grounds that the UI already prevents
 * it — a forged WebSocket frame bypasses this component entirely.
 */
export function ModelSelector({
  roomId,
  token,
  events,
  driverId,
  selfId,
  onSetModel,
}: {
  roomId: string;
  token: string;
  events: NexusEvent[];
  driverId: string | null;
  selfId: string | null;
  onSetModel: (model: string | null) => void;
}): JSX.Element {
  const [models, setModels] = useState<ModelOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function loadModels(): Promise<void> {
      try {
        const response = await fetch(`/api/rooms/${roomId}/models`, {
          headers: { 'X-Nexus-Token': token },
        });
        if (!response.ok) return;
        const payload = (await response.json().catch(() => null)) as { models?: ModelOption[] } | null;
        if (!cancelled && Array.isArray(payload?.models)) {
          setModels(payload.models);
        }
      } catch {
        // No connectivity, no room: the selector just falls back to "Default"
        // only, same as a room with no models endpoint yet.
      }
    }
    void loadModels();
    return () => {
      cancelled = true;
    };
  }, [roomId, token]);

  // Derived from the log (I3), never local state: the last model_changed
  // event is the truth, and a room with no such event yet is still on the
  // account default — the same state `model: null` represents on the wire.
  const modelChangedEvents = events.filter(
    (event): event is Extract<NexusEvent, { type: 'model_changed' }> => event.type === 'model_changed',
  );
  const currentModel = modelChangedEvents[modelChangedEvents.length - 1]?.model ?? null;

  // Anyone may drive the room when the floor is open (I2' — see App.tsx:110-115
  // for prompts). ModelSelector is the one deliberate exception: switching the
  // model changes the session for everyone, so it stays driver-gated while a
  // driver holds the token, and opens back up the moment nobody does.
  const hasDriver = driverId !== null;
  const iAmDriver = driverId !== null && driverId === selfId;
  const disabled = hasDriver && !iAmDriver;

  function handleChange(next: string): void {
    onSetModel(next === DEFAULT_OPTION_VALUE ? null : next);
  }

  // A model named by the last model_changed event might not (yet, or ever)
  // be in the fetched list — the fetch can still be in flight, or a model id
  // can be retired between fetch and event. Render it as its own option so
  // the <select>'s value always matches a rendered option; a mismatch would
  // otherwise render as no visible selection at all.
  const knownValues = new Set(models.map((model) => model.value));
  const unlistedCurrentModel =
    currentModel !== null && !knownValues.has(currentModel) ? currentModel : null;

  return (
    <div
      className="flex min-h-11 items-center gap-1.5 rounded border border-border px-2 text-xs text-fg-muted"
      title={
        disabled
          ? 'Only the driver can switch the room model while someone is driving'
          : 'Switch the model for this room'
      }
    >
      <Cpu size={14} aria-hidden="true" />
      <select
        aria-label="Room model"
        disabled={disabled}
        value={currentModel ?? DEFAULT_OPTION_VALUE}
        onChange={(event) => handleChange(event.target.value)}
        className="min-h-11 rounded border-none bg-transparent text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:text-fg-muted disabled:opacity-60"
      >
        <option value={DEFAULT_OPTION_VALUE}>Default</option>
        {unlistedCurrentModel !== null && (
          <option value={unlistedCurrentModel}>{unlistedCurrentModel}</option>
        )}
        {models.map((model) => (
          <option key={model.value} value={model.value} title={model.description}>
            {model.displayName}
          </option>
        ))}
      </select>
    </div>
  );
}
