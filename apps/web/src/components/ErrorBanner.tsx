import { Notice } from './Notice.js';

/**
 * Signature unchanged so App.tsx's phase-3d dismiss-by-count wiring (App.tsx
 * lines 33-39) keeps working untouched: bannerMessage is derived from
 * `errorCount > dismissedCount`, not from comparing message text, because
 * "You are not driving" repeats and comparing text alone would swallow every
 * repeat after the first dismissal. Internally this now just renders a
 * `Notice`.
 */
export function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}): JSX.Element | null {
  if (message === null) return null;
  return <Notice severity="error" message={message} onDismiss={onDismiss} />;
}
