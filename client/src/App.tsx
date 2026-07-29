import { useEffect, useMemo, useState } from 'react';
import { deriveApprovals } from './approvals.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { ConnectionStatus } from './components/ConnectionStatus.js';
import { MessageList } from './components/MessageList.js';
import { PromptInput } from './components/PromptInput.js';
import { Roster } from './components/Roster.js';
import { EMPTY_VIEW } from './store.js';
import type { RoomView } from './store.js';
import { connect } from './ws.js';
import type { Connection, Status } from './ws.js';
import { CreateRoom } from './pages/CreateRoom.js';

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
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (params.roomId === '' || params.token === '') return undefined;
    const active = connect({ ...params, onView: setView, onStatus: setStatus });
    setConnection(active);
    return () => active.close();
  }, [params]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // --- BEGIN phase-3c landing-page slot: replace this branch with <CreateRoom/>. ---
  if (params.roomId === '' || params.token === '') {
    return <CreateRoom onCreated={(link) => globalThis.location.assign(link)} />;
  }
  // --- END phase-3c landing-page slot ---

  return (
    <main className="mx-auto flex h-screen max-w-3xl flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Nexus</h1>
        <div className="flex items-center gap-2">
          {/* --- BEGIN phase-2b roster slot: replace this span with <Roster/>. --- */}
          <Roster
            participants={view.participants}
            driverId={view.driverId}
            selfId={view.selfId}
            onRequestControl={() => connection?.send({ kind: 'request_control' })}
            onReleaseControl={() => connection?.send({ kind: 'release_control' })}
            onGrantControl={(toParticipantId) =>
              connection?.send({ kind: 'grant_control', toParticipantId })
            }
          />
          {/* --- END phase-2b roster slot --- */}
          <ConnectionStatus status={status} />
        </div>
      </header>

      {/* --- BEGIN phase-3d error banner slot: render <ErrorBanner/> here. --- */}
      {/* --- END phase-3d error banner slot --- */}

      {/* --- BEGIN phase-2d approval slot --- */}
      {deriveApprovals(view.events).pending.map((approval) => (
        <ApprovalPrompt
          key={approval.requestId}
          approval={approval}
          now={now}
          onDecide={(requestId, decision, reason) =>
            connection?.send(
              reason === undefined
                ? { kind: 'permission_decision', requestId, decision }
                : { kind: 'permission_decision', requestId, decision, reason },
            )
          }
        />
      ))}
      {/* --- END phase-2d approval slot --- */}

      <div className="flex-1 overflow-y-auto">
        <MessageList messages={view.messages} pendingDeltas={view.pendingDeltas} />
      </div>

      {/*
        The disabled input is presentation only. The server rejects non-driver
        input independently (Invariant I2, plan phase-2a) — never treat this as
        the gate.
      */}
      {/* --- BEGIN phase-3b stop-button slot: wrap in a flex row, add <StopButton/> beside it. --- */}
      <PromptInput
        disabled={status !== 'open'}
        onSubmit={(text) => connection?.send({ kind: 'prompt', text })}
      />
      {/* --- END phase-3b stop-button slot --- */}
    </main>
  );
}
