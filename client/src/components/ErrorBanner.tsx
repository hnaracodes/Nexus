export function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}): JSX.Element | null {
  if (message === null) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-between rounded bg-rose-50 px-3 py-2 text-sm text-rose-800"
    >
      <span>{message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="ml-4 underline">
        Dismiss
      </button>
    </div>
  );
}
