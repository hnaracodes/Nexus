import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Check,
  Eye,
  EyeOff,
  GitBranch,
  Globe,
  Link2,
  Loader2,
  Lock,
  ShieldAlert,
} from 'lucide-react';

const KEY_PREFIX = 'sk-ant-';

/**
 * One repository the GitHub App is installed on and the server has verified.
 * Mirrors an entry of `GET /api/github/repos`. Deliberately declared here and
 * not imported from `src/protocol/events.ts`: `GithubRepoRef` is the *binding*
 * persisted on a room (installation id, no visibility), whereas this is the
 * picker's view of a candidate. Reusing the protocol type would force
 * `private` into it, where it has no business being.
 */
interface PickerRepo {
  owner: string;
  repo: string;
  defaultBranch: string;
  private: boolean;
}

interface PickerInstallation {
  installationId: number;
  account: string;
  repositories: PickerRepo[];
}

export function CreateRoom({ onCreated }: { onCreated: (link: string) => void }): JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // --- GitHub App state -------------------------------------------------
  // Every one of these is optional by construction. A deployment with no
  // GitHub App configured reports `enabled: false` and must remain a fully
  // working room-creation page, so nothing below may gate the plain path.
  const [githubEnabled, setGithubEnabled] = useState(false);
  // GitHub returns the user to `/?connect=<connectId>`. Read once, at mount:
  // it is a short-lived server-side session handle, so it belongs in
  // component state and in a request body — never in localStorage (I4's
  // spirit: a credential that outlives the tab is a credential that leaks).
  const [connectId] = useState<string | null>(
    () => new URLSearchParams(globalThis.location.search).get('connect'),
  );
  const [installations, setInstallations] = useState<PickerInstallation[] | null>(null);
  /**
   * Seeded from `?github_error=`, which the server sets when the authorize
   * round trip itself failed — a replayed or expired single-use `state`, or a
   * failed code exchange. The server cannot say more than that, because the
   * underlying error describes a request carrying the client secret.
   *
   * Without reading it the page is a silent dead end: the user comes back with
   * no `connect` handle, no message, and an ordinary "Connect GitHub" button,
   * so the obvious next action is to click it and loop.
   */
  const [connectError, setConnectError] = useState<string | null>(() => {
    switch (new URLSearchParams(globalThis.location.search).get('github_error')) {
      case 'expired':
        return 'That GitHub sign-in link had already been used or had expired. Connect again to pick a repository.';
      case 'failed':
        return 'GitHub could not complete the sign-in. Connect again, and if it keeps failing check that the app is still installed.';
      default:
        return null;
    }
  });
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [selected, setSelected] = useState<PickerRepo | null>(null);

  // A `connect` handle in the URL only exists because GitHub sent the user
  // back, which means the App *is* configured — so treat it as available
  // without waiting for the status probe. That removes a render race where
  // the expired-session message appears before we know GitHub exists and the
  // "connect again" button is briefly missing.
  const githubAvailable = githubEnabled || connectId !== null;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/github/status');
        if (!response.ok) return;
        const payload = (await response.json()) as { enabled?: boolean };
        if (!cancelled) setGithubEnabled(payload.enabled === true);
      } catch {
        // GitHub is an optional integration. If the probe fails for any
        // reason the page silently stays in plain repo-URL mode rather than
        // showing an error for a feature the user may not even want.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (connectId === null) return;
    let cancelled = false;
    setLoadingRepos(true);
    void (async () => {
      try {
        // The connect handle travels as a query parameter because that is the
        // server's contract for this GET. It is not the API key and never
        // appears in the room link handed to other people.
        const response = await fetch(
          `/api/github/repos?connect=${encodeURIComponent(connectId)}`,
        );
        if (response.status === 404 || response.status === 410) {
          if (!cancelled) {
            setConnectError(
              'That GitHub connection has expired. Connect again to pick a repository.',
            );
          }
          return;
        }
        if (!response.ok) {
          if (!cancelled) {
            setConnectError('Could not load your repositories from GitHub. Try connecting again.');
          }
          return;
        }
        const payload = (await response.json()) as { installations?: PickerInstallation[] };
        if (!cancelled) setInstallations(payload.installations ?? []);
      } catch {
        if (!cancelled) {
          setConnectError('Could not reach GitHub. Check your connection and try again.');
        }
      } finally {
        if (!cancelled) setLoadingRepos(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectId]);

  function startConnect(): void {
    // A full navigation, not a fetch: the server answers with a 302 to
    // github.com and the user has to see and approve the install screen.
    globalThis.location.assign('/api/github/connect');
  }

  // The two repository sources are alternatives, so selecting one clears the
  // other. Enforcing exclusivity in the state transitions rather than only at
  // submit time is what makes "never send both" structurally true instead of
  // a rule the request builder has to remember.
  function chooseRepo(repository: PickerRepo): void {
    setSelected(repository);
    setRepoUrl('');
  }

  function changeRepoUrl(value: string): void {
    setRepoUrl(value);
    if (value !== '') setSelected(null);
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;

    // Client-side validation is feedback, not enforcement — the server
    // rejects a malformed key regardless (create.ts:77-89). This just saves
    // a round trip for the common case of a pasted typo.
    if (!apiKey.startsWith(KEY_PREFIX)) {
      setError(`Console API keys start with "${KEY_PREFIX}". Check what you pasted and try again.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // Exactly one of the two shapes, never a merge of both: the server
      // reads `connectId` to mint a scoped clone token and `repoUrl` to run a
      // plain anonymous clone, and sending both would leave which one wins up
      // to the server's field ordering.
      let body: Record<string, string>;
      if (selected !== null && connectId !== null) {
        body = { apiKey, connectId, owner: selected.owner, repo: selected.repo };
      } else {
        body = { apiKey, repoUrl };
      }

      // The key goes in the body, over HTTPS, once. Never in a URL, never in
      // localStorage, never held in state after this call returns.
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { roomId?: string; token?: string; error?: string };
      if (!response.ok) {
        setError(payload.error ?? 'Could not create the room. Try again.');
        return;
      }
      setApiKey('');
      setLink(`${globalThis.location.origin}/?room=${payload.roomId ?? ''}&token=${payload.token ?? ''}`);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy(): Promise<void> {
    if (link === null) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied by the browser; the link is still
      // selectable text in the field below, so this is not fatal.
    }
  }

  if (link !== null) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center p-8">
        <div className="rounded-lg border border-border bg-surface p-6">
          <h1 className="mb-2 text-2xl font-semibold text-fg">Your room is ready</h1>
          <p className="mb-4 text-fg-muted">
            Copy this link now — it will not be shown again on this page.
          </p>

          <label className="mb-4 flex flex-col gap-1 text-sm">
            <span className="text-fg">Room link</span>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={link}
                aria-label="Room link"
                onFocus={(event) => event.currentTarget.select()}
                className="min-w-0 flex-1 rounded border border-border bg-muted px-3 py-2 font-mono text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              />
              <button
                type="button"
                onClick={handleCopy}
                aria-label={copied ? 'Link copied' : 'Copy link'}
                title={copied ? 'Copied' : 'Copy link'}
                className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded border border-border bg-surface-2 px-3 text-sm font-medium text-fg transition-colors duration-150 ease-out hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                {copied ? (
                  <Check size={16} strokeWidth={2} className="text-accent" aria-hidden="true" />
                ) : (
                  <Link2 size={16} strokeWidth={2} aria-hidden="true" />
                )}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </label>

          <div className="mb-6 flex items-start gap-3 rounded-md border border-warn bg-muted p-4 text-sm">
            <ShieldAlert size={20} strokeWidth={2} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
            <p className="text-fg">
              This link is the credential. Anyone who has it is a full participant in this room —
              share it only with people you trust.
            </p>
          </div>

          <a
            href={link}
            className="flex min-h-11 items-center justify-center rounded bg-accent px-4 py-2 text-center font-medium text-bg transition-colors duration-150 ease-out hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            Enter the room
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center p-8">
      <h1 className="mb-2 text-2xl font-semibold text-fg">Open a Nexus room</h1>
      <p className="mb-6 text-fg-muted">
        One agent, one context window, everyone in the room watching the same thing.
      </p>

      <div className="mb-6 flex items-start gap-3 rounded-md border border-warn bg-muted p-4 text-sm">
        <ShieldAlert size={20} strokeWidth={2} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
        <div className="text-fg">
          <p className="mb-2 font-semibold">A shared room is a shared security boundary.</p>
          <p className="mb-2">
            Whatever the room can do, every participant can do — read <code>.env</code>, use your
            git credentials, run commands.
          </p>
          <p className="mb-2">
            Nexus has no isolation between rooms. Only share this link with people you trust.
          </p>
          <a href="/security" className="font-medium text-info underline underline-offset-2">
            Read the full security model
          </a>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface p-6">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-fg">Anthropic Console API key</span>
            <div className="flex gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  if (error !== null) setError(null);
                }}
                placeholder="sk-ant-…"
                className="min-w-0 flex-1 rounded border border-border bg-muted px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              />
              <button
                type="button"
                onClick={() => setShowKey((value) => !value)}
                aria-label={showKey ? 'Hide key value' : 'Show key value'}
                title={showKey ? 'Hide key value' : 'Show key value'}
                className="flex min-h-11 min-w-11 items-center justify-center rounded border border-border bg-surface-2 text-fg-muted transition-colors duration-150 ease-out hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                {showKey ? (
                  <EyeOff size={16} strokeWidth={2} aria-hidden="true" />
                ) : (
                  <Eye size={16} strokeWidth={2} aria-hidden="true" />
                )}
              </button>
            </div>
            <span className="text-xs text-fg-muted">
              Console keys only (<code>sk-ant-…</code>). Claude Free, Pro and Max logins cannot be
              used by third-party tools. The key is sent once over HTTPS and is never written to
              the event log.
            </span>
          </label>

          {/* The whole GitHub block is absent when no App is configured, so a
              plain deployment sees exactly the page it saw before phase 6. */}
          {githubAvailable && (
            <div className="flex flex-col gap-3 rounded-md border border-border bg-muted p-4">
              <p className="text-sm font-semibold text-fg">Private repository via GitHub</p>

              {installations !== null && installations.length > 0 ? (
                <>
                  <fieldset className="flex flex-col gap-3 border-0 p-0">
                    <legend className="sr-only">Choose a repository</legend>
                    {installations.map((installation) => (
                      <div key={installation.installationId} className="flex flex-col gap-1">
                        <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                          {installation.account}
                        </p>
                        {installation.repositories.map((repository) => {
                          const id = `${repository.owner}/${repository.repo}`;
                          const isChosen =
                            selected?.owner === repository.owner &&
                            selected?.repo === repository.repo;
                          return (
                            <label
                              key={id}
                              className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-sm transition-colors duration-150 ease-out ${
                                isChosen
                                  ? 'border-accent bg-surface-2'
                                  : 'border-border hover:bg-surface-2'
                              }`}
                            >
                              <input
                                type="radio"
                                name="github-repo"
                                value={id}
                                checked={isChosen}
                                onChange={() => chooseRepo(repository)}
                              />
                              <span className="min-w-0 flex-1 truncate font-mono text-fg">{id}</span>
                              <span className="flex items-center gap-1 text-xs text-fg-muted">
                                <GitBranch size={12} strokeWidth={2} aria-hidden="true" />
                                {repository.defaultBranch}
                              </span>
                              {repository.private ? (
                                <span className="flex items-center gap-1 rounded bg-surface-2 px-2 py-0.5 text-xs font-medium text-warn">
                                  <Lock size={12} strokeWidth={2} aria-hidden="true" />
                                  Private
                                </span>
                              ) : (
                                <span className="flex items-center gap-1 rounded bg-surface-2 px-2 py-0.5 text-xs font-medium text-fg-muted">
                                  <Globe size={12} strokeWidth={2} aria-hidden="true" />
                                  Public
                                </span>
                              )}
                            </label>
                          );
                        })}
                      </div>
                    ))}
                  </fieldset>

                  {/* Not a bug and not a temporary limitation: a room owns one
                      working directory for the life of its context window. */}
                  <p className="text-xs text-fg-muted">
                    A room&rsquo;s repository is fixed when the room is created and{' '}
                    <strong className="font-semibold text-fg">cannot be changed</strong> afterwards.
                    To work on a different repository, open a new room.
                  </p>

                  <button
                    type="button"
                    onClick={startConnect}
                    className="self-start text-xs font-medium text-info underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                  >
                    Connect GitHub again to add repositories
                  </button>
                </>
              ) : (
                <>
                  {connectError !== null && (
                    <p
                      role="alert"
                      className="rounded-md border border-danger bg-surface px-3 py-2 text-sm text-fg"
                    >
                      {connectError}
                    </p>
                  )}
                  {connectError === null && loadingRepos && (
                    <p className="flex items-center gap-2 text-sm text-fg-muted">
                      <Loader2 size={14} strokeWidth={2} className="animate-spin" aria-hidden="true" />
                      Loading your repositories&hellip;
                    </p>
                  )}
                  {connectError === null && !loadingRepos && installations !== null && (
                    <p className="text-sm text-fg-muted">
                      The Nexus GitHub App is not installed on any repositories yet.
                    </p>
                  )}
                  {!loadingRepos && (
                    <button
                      type="button"
                      onClick={startConnect}
                      className="flex min-h-11 items-center justify-center gap-2 self-start rounded border border-border bg-surface-2 px-4 py-2 text-sm font-medium text-fg transition-colors duration-150 ease-out hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                    >
                      <GitBranch size={16} strokeWidth={2} aria-hidden="true" />
                      Connect GitHub
                    </button>
                  )}
                  <p className="text-xs text-fg-muted">
                    You choose which repositories the App can reach. Nexus clones with a
                    short-lived token that never reaches your browser or the event log.
                  </p>
                </>
              )}
            </div>
          )}

          {githubAvailable && (
            <p className="text-center text-xs font-medium uppercase tracking-wide text-fg-muted">
              or use a public repository
            </p>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-fg">
              Repository URL {githubAvailable ? '(alternative to the list above)' : '(optional)'}
            </span>
            <input
              type="url"
              value={repoUrl}
              onChange={(event) => changeRepoUrl(event.target.value)}
              placeholder="https://github.com/you/project.git"
              className="rounded border border-border bg-muted px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            />
            <span className="text-xs text-fg-muted">
              {selected === null ? (
                <>
                  Cloning happens server-side. A URL with an embedded username or password (
                  <code>user:pass@host</code>) is rejected.
                </>
              ) : (
                <>
                  Ignored while <code>{`${selected.owner}/${selected.repo}`}</code> is selected
                  above — a room clones one repository, not two.
                </>
              )}
            </span>
          </label>

          {error !== null && (
            <p
              role="alert"
              className="rounded-md border border-danger bg-muted px-3 py-2 text-sm text-fg"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="flex min-h-11 items-center justify-center gap-2 rounded bg-accent px-4 py-2 font-medium text-bg transition-colors duration-150 ease-out hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            {busy && (
              <Loader2 size={16} strokeWidth={2} className="animate-spin" aria-hidden="true" />
            )}
            {busy ? 'Creating room…' : 'Create room'}
          </button>
        </form>
      </div>
    </main>
  );
}
