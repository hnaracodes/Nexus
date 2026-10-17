import { Markdown } from '../markdown.js';

/**
 * Rendered Markdown for the side-by-side preview. Uses the app's own
 * `Markdown` renderer (React elements, never HTML injection), so a hostile
 * README cannot inject markup into the room.
 */
export function MarkdownPreview({ text }: { text: string }): JSX.Element {
  return (
    <div
      role="region"
      aria-label="Markdown preview"
      className="h-full min-h-0 overflow-auto bg-bg px-6 py-4 text-sm text-fg"
    >
      <Markdown text={text} />
    </div>
  );
}
