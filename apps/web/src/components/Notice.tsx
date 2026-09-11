import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { AlertOctagon, AlertTriangle, Info, ShieldAlert, X } from 'lucide-react';

export type Severity = 'info' | 'warn' | 'error' | 'fatal';

export interface NoticeAction {
  label: string;
  onAct: () => void;
}

export interface NoticeProps {
  severity: Severity;
  message: string;
  action?: NoticeAction;
  onDismiss?: () => void;
}

const ICONS: Record<Severity, typeof Info> = {
  info: Info,
  warn: AlertTriangle,
  error: AlertOctagon,
  fatal: ShieldAlert,
};

const ICON_COLOR: Record<Severity, string> = {
  info: 'text-info',
  warn: 'text-warn',
  error: 'text-danger',
  fatal: 'text-danger',
};

const BORDER_COLOR: Record<Severity, string> = {
  info: 'border-info',
  warn: 'border-warn',
  error: 'border-danger',
  fatal: 'border-danger',
};

/** info/warn are ambient status; error/fatal are alarms that must interrupt. */
const ROLE: Record<Severity, 'status' | 'alert'> = {
  info: 'status',
  warn: 'status',
  error: 'alert',
  fatal: 'alert',
};

const AUTO_DISMISS_MS = 6_000;
/** error and fatal never auto-dismiss — the person must act or explicitly close them. */
const AUTO_DISMISSIBLE: ReadonlySet<Severity> = new Set(['info', 'warn']);

/**
 * A single severity-typed notice. Colour never carries meaning alone — every
 * severity also renders its own icon and an accessible role/live-region.
 */
export function Notice({ severity, message, action, onDismiss }: NoticeProps): JSX.Element {
  useEffect(() => {
    if (!AUTO_DISMISSIBLE.has(severity) || onDismiss === undefined) return undefined;
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
    // Re-arm only when the underlying notice actually changes, not on every
    // render (onDismiss is frequently a fresh closure per render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [severity, message]);

  const Icon = ICONS[severity];
  const role = ROLE[severity];

  return (
    <div
      role={role}
      aria-live={role === 'alert' ? 'assertive' : 'polite'}
      className={`flex items-start gap-3 rounded-lg border bg-surface p-3 text-sm text-fg shadow-[0_8px_24px_rgb(0,0,0,0.4)] ${BORDER_COLOR[severity]}`}
    >
      <Icon size={16} className={`mt-0.5 shrink-0 ${ICON_COLOR[severity]}`} aria-hidden="true" />
      <div className="flex-1">
        <p>{message}</p>
        {action !== undefined && (
          <button
            type="button"
            onClick={action.onAct}
            className="mt-2 min-h-11 rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg transition-colors duration-150 hover:brightness-110 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            {action.label}
          </button>
        )}
      </div>
      {onDismiss !== undefined && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          title="Dismiss"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors duration-150 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * Recovery dialog for WS close code 4409 (room recovered without its API
 * key — src/server/recovery.ts). Treats the key exactly as CreateRoom.tsx
 * does (I4): request body only, over `X-SynCode-Token`, never a URL, never
 * localStorage, cleared from state whether the request succeeds or fails.
 * This component only renders the dialog; detecting the 4409 close code and
 * deciding when to mount it belongs to the integration pass over App.tsx.
 */
export function ReKeyDialog({
  roomId,
  token,
  onSubmitted,
  onCancel,
}: {
  roomId: string;
  token: string;
  onSubmitted: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const dialogRef = useRef<HTMLFormElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const id = window.setTimeout(() => {
      const input = dialogRef.current?.querySelector<HTMLElement>('input');
      (input ?? dialogRef.current)?.focus();
    }, 0);
    return () => {
      window.clearTimeout(id);
      previouslyFocused.current?.focus();
    };
    // Capture/restore once per mount — this dialog is mounted and unmounted
    // by the parent rather than toggled via an `open` prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function focusableElements(): HTMLElement[] {
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, [tabindex]:not([tabindex="-1"])',
    );
    return nodes ? Array.from(nodes) : [];
  }

  function handleKeyDown(event: React.KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const list = focusableElements();
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleCancel(): void {
    previouslyFocused.current?.focus();
    onCancel();
  }

  function handleSubmitted(): void {
    previouslyFocused.current?.focus();
    onSubmitted();
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/rooms/${roomId}/key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-SynCode-Token': token },
        body: JSON.stringify({ apiKey }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(payload?.error ?? 'Could not save the key. Try again.');
        return;
      }
      handleSubmitted();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
      // Never held in state after the request settles, success or failure (I4).
      setApiKey('');
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-40 flex items-center justify-center bg-bg/80 p-4"
    >
      <form
        ref={dialogRef}
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        onKeyDown={handleKeyDown}
        className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-[0_8px_24px_rgb(0,0,0,0.4)]"
      >
        <h2 id={titleId} className="text-base font-semibold text-fg">
          Re-enter API key
        </h2>
        <p className="text-xs text-fg-muted">
          The room lost its API key when the server restarted. Re-enter it to continue — it stays
          on the server and is never written to the event log.
        </p>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-fg">Anthropic Console API key</span>
          <input
            type="password"
            value={apiKey}
            autoComplete="off"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk-ant-…"
            className="min-h-11 rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          />
        </label>
        {error !== null && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={handleCancel}
            className="min-h-11 rounded-md border border-border px-4 py-2 text-sm text-fg transition-colors duration-150 hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="min-h-11 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-bg transition-colors duration-150 hover:brightness-110 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            {busy ? 'Saving…' : 'Save key'}
          </button>
        </div>
      </form>
    </div>
  );
}
