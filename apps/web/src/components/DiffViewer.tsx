import { AlertTriangle } from 'lucide-react';
import type { DiffHunk, DiffLine } from '../derive/diff.js';
import { anchorEdit, diffLines } from '../derive/diff.js';
import { parseFileToolInput } from '../derive/workspaceFiles.js';

export interface DiffViewerProps {
  toolName: string;
  /** `unknown` on the wire (`ToolStart.input` / `PermissionRequested.input`) — guarded internally. */
  input: unknown;
  /** The most recently known content of the file, or `null` if never cached. */
  cachedContent: string | null;
}

const GUTTER_GLYPH: Record<DiffLine['kind'], string> = {
  add: '+',
  remove: '-',
  context: ' ',
};

const LINE_TINT: Record<DiffLine['kind'], string> = {
  add: 'bg-accent-dim/40',
  remove: 'bg-danger/10',
  context: '',
};

/**
 * Turns `{old_string, new_string}` (or `{content}` for `Write`) into a
 * rendered diff — the governance payoff: approving an `Edit` becomes
 * approving a diff, not a JSON blob. Colour never carries meaning alone:
 * every line gets a `+`/`-`/space gutter glyph, tints are additive, and each
 * hunk carries an `aria-label` with add/remove counts.
 */
export function DiffViewer({ toolName, input, cachedContent }: DiffViewerProps): JSX.Element {
  const parsed = parseFileToolInput(toolName, input);

  if (parsed === null) {
    return (
      <ContextUnavailableBanner message={`No diff preview available for ${toolName}.`} />
    );
  }

  if (parsed.kind === 'write') {
    const hunk = diffLines(cachedContent ?? '', parsed.content);
    return (
      <div className="flex flex-col gap-2">
        {cachedContent === null && (
          <ContextUnavailableBanner message="Original content not cached — showing the new content as an addition." />
        )}
        <Hunk hunk={hunk} filePath={parsed.filePath} />
      </div>
    );
  }

  const anchored = anchorEdit(cachedContent, parsed.oldString, parsed.newString);
  if (anchored.contextUnavailable) {
    const fallback = diffLines(parsed.oldString, parsed.newString);
    return (
      <div className="flex flex-col gap-2">
        <ContextUnavailableBanner message={reasonMessage(anchored.reason)} />
        <Hunk hunk={fallback} filePath={parsed.filePath} noLineNumbers />
      </div>
    );
  }

  return <Hunk hunk={anchored.hunk} filePath={parsed.filePath} />;
}

function reasonMessage(reason: 'not_cached' | 'zero_occurrences' | 'multiple_occurrences'): string {
  switch (reason) {
    case 'not_cached':
      return 'Original content not cached — showing the edited fragment without surrounding context or real line numbers.';
    case 'zero_occurrences':
      return 'This edit no longer matches the cached file content — showing the edited fragment without real line numbers.';
    case 'multiple_occurrences':
      return 'This edit matches more than one place in the file — showing the edited fragment without real line numbers.';
  }
}

function ContextUnavailableBanner({ message }: { message: string }): JSX.Element {
  return (
    <div className="flex items-start gap-2 rounded border border-warn bg-surface px-3 py-2 text-xs text-warn">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function Hunk({
  hunk,
  filePath,
  noLineNumbers = false,
}: {
  hunk: DiffHunk;
  filePath: string;
  noLineNumbers?: boolean;
}): JSX.Element {
  const label = `${filePath}: ${hunk.addCount} line${hunk.addCount === 1 ? '' : 's'} added, ${hunk.removeCount} line${
    hunk.removeCount === 1 ? '' : 's'
  } removed`;

  return (
    <div
      role="group"
      aria-label={label}
      className="overflow-x-auto rounded border border-border bg-bg font-mono text-[13px]"
    >
      {hunk.lines.map((line, i) => (
        <div key={i} className={`flex ${LINE_TINT[line.kind]}`}>
          {!noLineNumbers && (
            <>
              <span className="w-10 shrink-0 select-none border-r border-border px-1.5 text-right text-fg-muted">
                {line.oldLineNo ?? ''}
              </span>
              <span className="w-10 shrink-0 select-none border-r border-border px-1.5 text-right text-fg-muted">
                {line.newLineNo ?? ''}
              </span>
            </>
          )}
          <span
            className={`w-4 shrink-0 select-none text-center ${
              line.kind === 'add' ? 'text-accent' : line.kind === 'remove' ? 'text-danger' : 'text-fg-muted'
            }`}
            aria-hidden="true"
          >
            {GUTTER_GLYPH[line.kind]}
          </span>
          <span className="flex-1 whitespace-pre-wrap break-words px-1 text-fg">{line.text}</span>
        </div>
      ))}
    </div>
  );
}
