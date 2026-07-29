import { useState } from 'react';
import type { FormEvent } from 'react';

export function CreateRoom({ onCreated }: { onCreated: (link: string) => void }): JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // The key goes in the body, over HTTPS, once. Never in a URL, never in
      // localStorage, never held after this call returns.
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey, repoUrl }),
      });
      const payload = (await response.json()) as { roomId?: string; token?: string; error?: string };
      if (!response.ok) {
        setError(payload.error ?? 'Could not create the room. Try again.');
        return;
      }
      setApiKey('');
      onCreated(
        `${globalThis.location.origin}/?room=${payload.roomId ?? ''}&token=${payload.token ?? ''}`,
      );
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="mb-2 text-2xl font-semibold">Open a Nexus room</h1>
      <p className="mb-6 text-sm text-slate-600">
        One agent, one context window, everyone in the room watching the same thing.
      </p>

      <div className="mb-6 rounded border-2 border-amber-400 bg-amber-50 p-4 text-sm">
        <p className="mb-2 font-semibold text-amber-900">
          A shared room is a shared security boundary.
        </p>
        <p className="text-amber-900">
          Whatever the room can do, every participant can do — read <code>.env</code>, use your git
          credentials, run commands. Only share this link with people you trust. Rooms are not
          isolated from each other in this preview.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span>Anthropic Console API key</span>
          <input
            type="password"
            value={apiKey}
            autoComplete="off"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk-ant-…"
            className="rounded border border-slate-300 px-3 py-2 font-mono text-sm"
          />
          <span className="text-xs text-slate-500">
            Console keys only. Claude Free, Pro, and Max logins cannot be used by third-party tools.
            The key stays on the server and is never written to the event log.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span>Git repository to clone (optional)</span>
          <input
            type="url"
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            placeholder="https://github.com/you/project.git"
            className="rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </label>

        {error !== null && (
          <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-40"
        >
          {busy ? 'Creating…' : 'Create room'}
        </button>
      </form>
    </main>
  );
}
