import { useEffect, useMemo, useState } from 'react';
import { ConnectionStatus } from './components/ConnectionStatus.js';
import { MessageList } from './components/MessageList.js';
import { PromptInput } from './components/PromptInput.js';
import { EMPTY_VIEW } from './store.js';
import type { RoomView } from './store.js';
import { connect } from './ws.js';
import type { Connection, Status } from './ws.js';

function readParams(): { roomId: string; token: string; displayName: string } {
  const params = new URLSearchParams(globalThis.location.search);
  return {
    roomId: params.get('room') ?? '',
    token: params.get('token') ?? '',
    displayName: params.get('name') ?? 'anonymous',
  };
}

export default function App(): JSX.Element {
  const params = useMemo(readParams, []);
  const [view, setView] = useState<RoomView>(EMPTY_VIEW);
  const [status, setStatus] = useState<Status>('connecting');
  const [connection, setConnection] = useState<Connection | null>(null);

  useEffect(() => {
    if (params.roomId === '' || params.token === '') return undefined;
    const active = connect({ ...params, onView: setView, onStatus: setStatus });
    setConnection(active);
    return () => active.close();
  }, [params]);

  if (params.roomId === '' || params.token === '') {
    return <main className="p-6 text-slate-900">Nexus</main>;
  }

  return (
    <main className="mx-auto flex h-screen max-w-3xl flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Nexus</h1>
        <div className="flex items-center gap-2">
          {/* --- BEGIN phase-2b roster slot: replace this span with <Roster/>. --- */}
          <span className="text-xs text-slate-500">{view.participants.length} here</span>
          {/* --- END phase-2b roster slot --- */}
          <ConnectionStatus status={status} />
        </div>
      </header>

      {/*
        --- BEGIN phase-2d approval slot: render pending <ApprovalPrompt/> cards here. ---
        Derive them from `view.events` (the raw log) via deriveApprovals.
        --- END phase-2d approval slot ---
      */}

      <div className="flex-1 overflow-y-auto">
        <MessageList messages={view.messages} pendingDeltas={view.pendingDeltas} />
      </div>

      {/*
        The disabled input is presentation only. The server rejects non-driver
        input independently (Invariant I2, plan phase-2a) — never treat this as
        the gate.
      */}
      <PromptInput
        disabled={status !== 'open'}
        onSubmit={(text) => connection?.send({ kind: 'prompt', text })}
      />
    </main>
  );
}
