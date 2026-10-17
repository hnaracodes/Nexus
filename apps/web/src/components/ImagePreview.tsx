import { useEffect, useState } from 'react';
import { Binary, Loader2 } from 'lucide-react';
import type { WorkspaceApi } from '../workspace/workspaceApi.js';

type State =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'failed' };

/**
 * An image file shown as an image. Fetches the bytes with the token header
 * (never a query param), shows them via a blob URL, and revokes that URL when
 * the path changes or the tab closes.
 *
 * NOT VERIFIED END TO END: the server's raw-bytes route and a CSP that allows
 * `img-src blob:` do not exist yet. Until they do, the fetch rejects and — by
 * design — this degrades to the same "Binary file" card every other binary
 * file gets, so nothing breaks before the server unit lands.
 */
export function ImagePreview({ api, path }: { api: WorkspaceApi; path: string }): JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ status: 'loading' });
    api
      .getFileBlob(path)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ status: 'ready', url: objectUrl });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'failed' });
      });
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [api, path]);

  if (state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-fg-muted">
        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
        Loading…
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-fg-muted">
        <Binary size={16} aria-hidden="true" />
        Binary file — no preview available.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-bg p-4">
      <img
        src={state.url}
        alt={path}
        // A broken blob (corrupt or unsupported image) falls back the same way.
        onError={() => setState({ status: 'failed' })}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}
