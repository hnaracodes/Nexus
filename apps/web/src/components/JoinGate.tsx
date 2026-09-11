import { useEffect, useRef, useState } from 'react';
import { SynCodeBlob } from './SynCodeBlob.js';
import { Button } from './Button.js';

/**
 * What you see when you open a room link that carries no name.
 *
 * Before this, that case silently became "anonymous" — so a room with three
 * people in it showed three rows called anonymous, the roster was useless, and
 * every prompt in the transcript was attributed to nobody. In a product whose
 * entire premise is *attributed* collaboration, an unnamed participant is not a
 * cosmetic gap; it defeats the feature.
 *
 * The gate is deliberately one field and one button. Anything more — avatars,
 * preferences, a tour — is friction in front of a room someone was invited to
 * three seconds ago.
 */

const NAME_KEY = (roomId: string): string => `nexus:name:${roomId}`;
const MAX_NAME = 32;

export function readStoredName(roomId: string): string | null {
  try {
    const stored = globalThis.localStorage?.getItem(NAME_KEY(roomId));
    return stored !== null && stored !== undefined && stored.trim() !== '' ? stored : null;
  } catch {
    return null;
  }
}

export function storeName(roomId: string, name: string): void {
  try {
    globalThis.localStorage?.setItem(NAME_KEY(roomId), name);
  } catch {
    /* storage disabled — the name still applies for this session */
  }
}

export function JoinGate({
  roomLabel,
  onJoin,
}: {
  roomLabel: string;
  onJoin: (displayName: string) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= MAX_NAME;

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-5 flex flex-col items-center text-center">
          <SynCodeBlob size={72} waving title="SynCode, the agent in this room" />
          <h1 className="mt-3 text-lg font-semibold text-fg">Join {roomLabel}</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Your name goes on every prompt you send and every call you approve.
          </p>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            // Persistence is the caller's job — it holds the room *id*, and
            // this component only knows the human-facing label.
            onJoin(trimmed);
          }}
          className="rounded-xl border border-border bg-surface p-4"
        >
          <label htmlFor="join-name" className="mb-1.5 block text-xs font-medium text-fg-muted">
            Display name
          </label>
          <input
            id="join-name"
            ref={inputRef}
            value={name}
            onChange={(event) => setName(event.target.value.slice(0, MAX_NAME))}
            maxLength={MAX_NAME}
            autoComplete="nickname"
            placeholder="Ada"
            className="mb-3 min-h-11 w-full rounded-[10px] border border-border-strong bg-bg px-3 text-sm text-fg placeholder:text-fg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          />
          <Button type="submit" variant="primary" disabled={!valid} className="w-full">
            Join room
          </Button>
        </form>

        {/*
          Said plainly here rather than buried in a docs link. A room is a
          shared trust boundary and this is the last moment before someone is
          inside one.
        */}
        <p className="mt-4 text-center text-xs leading-relaxed text-fg-muted">
          Everyone in this room shares its filesystem, its shell and its
          credentials. Only join rooms from people you trust.
        </p>
      </div>
    </div>
  );
}
