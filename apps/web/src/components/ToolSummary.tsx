/**
 * Risk classification and plain-language summaries for the tools the agent
 * calls through `canUseTool`. Shared between the approval card (Task 5) and
 * the transcript's collapsed tool rows (Task 7), so both agree on what "risky"
 * means.
 */

export type ToolRisk = 'destructive' | 'writing' | 'reading';

const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set(['Bash', 'KillShell']);
const WRITING_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit']);
/** Mirrors src/server/permissions.ts AUTO_APPROVE — the tools known to be read-only. */
const READING_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'TodoWrite',
]);

/**
 * Fails safe: a tool this table has never seen (a new SDK tool, a typo, a
 * forged frame) classifies as `destructive`, the same as `Bash`. Silently
 * treating an unrecognised tool as low-risk would be the exact wrong default
 * for a governance product.
 */
export function classifyTool(toolName: string): ToolRisk {
  if (DESTRUCTIVE_TOOLS.has(toolName)) return 'destructive';
  if (WRITING_TOOLS.has(toolName)) return 'writing';
  if (READING_TOOLS.has(toolName)) return 'reading';
  return 'destructive';
}

const MAX_SUMMARY_CHARS = 120;

function truncate(text: string): string {
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…` : text;
}

function firstScalarField(record: Record<string, unknown>): string | null {
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return `${key}: ${String(value)}`;
    }
  }
  return null;
}

/**
 * One plain-language line describing what the tool was asked to do. Never
 * throws on malformed input — the worst case is falling back to the tool
 * name, never a crash inside an approval card.
 */
export function summarizeToolInput(toolName: string, input: unknown): string {
  const record: Record<string, unknown> =
    input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};

  switch (toolName) {
    case 'Bash':
    case 'KillShell': {
      const command = record['command'];
      return truncate(typeof command === 'string' ? command : toolName);
    }
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
    case 'Read':
    case 'NotebookRead': {
      const path = record['file_path'] ?? record['path'];
      return truncate(typeof path === 'string' ? path : toolName);
    }
    default: {
      const fallback = firstScalarField(record);
      return truncate(fallback === null ? toolName : `${toolName}: ${fallback}`);
    }
  }
}
