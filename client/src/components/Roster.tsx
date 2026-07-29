import type { PresenceEntry } from '../../../src/protocol/wire.js';

export function Roster({
  participants,
  driverId,
  selfId,
  onRequestControl,
  onGrantControl,
  onReleaseControl,
}: {
  participants: PresenceEntry[];
  driverId: string | null;
  selfId: string | null;
  onRequestControl?: () => void;
  onGrantControl?: (participantId: string) => void;
  onReleaseControl?: () => void;
}): JSX.Element {
  const iAmDriving = driverId !== null && driverId === selfId;

  return (
    <div className="flex items-center gap-3">
      <ul className="flex items-center gap-2">
        {participants.map((p) => (
          <li
            key={p.participantId}
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${
              p.connected ? 'bg-slate-100 text-slate-800' : 'bg-slate-50 text-slate-400'
            }`}
          >
            <span>{p.displayName}</span>
            {p.participantId === driverId && (
              <span data-testid={`driver-${p.participantId}`} title="driving">
                🚗
              </span>
            )}
            {iAmDriving && p.participantId !== selfId && p.connected && (
              <button
                type="button"
                onClick={() => onGrantControl?.(p.participantId)}
                className="ml-1 text-slate-500 underline"
              >
                give control
              </button>
            )}
          </li>
        ))}
      </ul>

      {iAmDriving ? (
        <button
          type="button"
          onClick={onReleaseControl}
          className="rounded border px-2 py-1 text-xs"
        >
          Release control
        </button>
      ) : (
        <button
          type="button"
          onClick={onRequestControl}
          className="rounded border px-2 py-1 text-xs"
        >
          Request control
        </button>
      )}
    </div>
  );
}
