import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, FileText, Terminal } from 'lucide-react';

/**
 * Minimal, local one-line summarizer. Task 5 (`ApprovalPrompt.tsx` /
 * `classifyTool.ts`) owns the real `summarizeToolInput` contract described in
 * `docs/plans/phase-5b-room-ui-redesign.md` Task 5 — that file is outside this
 * agent's owned globs and was not present on disk at the time this file was
 * written (parallel dispatch). This is a deliberately small stand-in with the
 * same one-line, ~120-char-truncated shape so integration can swap it for the
 * real export without changing this component's behaviour.
 */
export function summarizeToolCall(toolName: string, input: unknown): string {
  const record =
    input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};

  let summary: string;
  if (toolName === 'Bash' && typeof record['command'] === 'string') {
    summary = record['command'];
  } else if (
    (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit' || toolName === 'Read') &&
    typeof record['file_path'] === 'string'
  ) {
    summary = record['file_path'];
  } else {
    const firstScalar = Object.entries(record).find(
      ([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
    );
    summary = firstScalar ? `${firstScalar[0]}: ${String(firstScalar[1])}` : toolName;
  }

  return summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
}

const MONO_TOOLS = new Set(['Bash', 'KillShell']);

export interface ToolCallRowProps {
  toolName: string;
  input: unknown;
  /** null while the tool is still running — no `tool_result` has arrived yet. */
  output: string | null;
  isError: boolean;
}

/**
 * Collapsed by default: icon + tool name + one-line summary. Expands to full
 * mono input/output. An errored result always renders expanded with danger
 * styling — colour never carries that meaning alone, so it also gets an
 * `AlertTriangle` icon and the word "Error".
 */
export function ToolCallRow({ toolName, input, output, isError }: ToolCallRowProps): JSX.Element {
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  const expanded = isError || manuallyExpanded;
  const Icon = MONO_TOOLS.has(toolName) ? Terminal : FileText;
  const summary = summarizeToolCall(toolName, input);
  const pending = output === null;

  return (
    <div
      className={`rounded border ${
        isError ? 'border-danger bg-surface' : 'border-border bg-surface'
      } px-3 py-2`}
    >
      <button
        type="button"
        onClick={() => setManuallyExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full min-h-[44px] items-center gap-2 text-left text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        {isError ? (
          <AlertTriangle size={16} className="shrink-0 text-danger" aria-hidden="true" />
        ) : (
          <Icon size={16} className="shrink-0 text-fg-muted" aria-hidden="true" />
        )}
        <span className="font-medium">{toolName}</span>
        {isError && <span className="text-danger text-xs font-semibold uppercase">Error</span>}
        {pending && !isError && (
          <span className="text-fg-muted text-xs uppercase">running</span>
        )}
        <span className="flex-1 truncate font-mono text-[13px] text-fg-muted">{summary}</span>
        {expanded ? (
          <ChevronDown size={16} className="shrink-0 text-fg-muted" aria-hidden="true" />
        ) : (
          <ChevronRight size={16} className="shrink-0 text-fg-muted" aria-hidden="true" />
        )}
      </button>

      {expanded && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="overflow-x-auto rounded bg-bg p-2">
            <pre className="whitespace-pre-wrap break-words font-mono text-[13px] text-fg-muted">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
          {output !== null && (
            <div className="overflow-x-auto rounded bg-bg p-2">
              <pre
                className={`whitespace-pre-wrap break-words font-mono text-[13px] ${
                  isError ? 'text-danger' : 'text-fg'
                }`}
              >
                {output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
