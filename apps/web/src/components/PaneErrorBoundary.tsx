import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/**
 * Contains a render-time throw to one pane instead of the whole room.
 *
 * React 18 unmounts the ENTIRE tree on an uncaught render error — a deliberate
 * default, on the grounds that a half-rendered UI is more dangerous than none.
 * For Nexus that default is backwards: this product's reason to exist is that
 * people can watch an agent and block what it is about to do, and a cosmetic
 * failure in the workspace pane must never take the transcript and the
 * approval gate down with it. That is exactly what happened in production —
 * `getTree` handed `FileTree` an envelope object, `for…of` threw, and with no
 * boundary anywhere in the client the room went blank a moment after painting.
 *
 * The thrown message is deliberately NOT rendered: an error raised while
 * rendering room content can quote that content, and this UI is shared by
 * definition. It goes to the console for whoever is debugging.
 */
interface Props {
  /** Human name for the failed region, e.g. "Workspace". Shown to the room. */
  label: string;
  /**
   * What is still working, in the reader's terms. Overridable because the
   * default is a CLAIM, and a claim that is false where it matters most is
   * worse than no claim: when the pane that died IS the approval queue,
   * telling someone "any approval you are being asked for is still live" is
   * precisely wrong. Callers that can host a governance surface pass their
   * own. See `SideBar.tsx`.
   */
  reassurance?: string;
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class PaneErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[nexus] ${this.props.label} pane crashed`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-4 text-center"
      >
        <p className="text-sm font-medium text-fg">{this.props.label} stopped responding.</p>
        <p className="max-w-xs text-xs text-fg-muted">
          {this.props.reassurance ??
            'The rest of the room — the transcript, and any approval you are being asked for — is still live. Reload to bring this panel back.'}
        </p>
        <button
          type="button"
          onClick={() => this.setState({ failed: false })}
          className="min-h-11 rounded border border-border px-3 text-xs text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Try again
        </button>
      </div>
    );
  }
}
