/**
 * A hand-rolled line diff — no dependency, per the plan's "no diff library"
 * constraint. Plain LCS over two known texts, plus the `Edit`-fragment
 * anchoring logic that turns `{old_string, new_string}` into a windowed diff
 * with real line numbers.
 */

export type DiffLineKind = 'context' | 'add' | 'remove';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based. `null` on an added line (it has no old-side position). */
  oldLineNo: number | null;
  /** 1-based. `null` on a removed line (it has no new-side position). */
  newLineNo: number | null;
}

export interface DiffHunk {
  lines: DiffLine[];
  addCount: number;
  removeCount: number;
}

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/**
 * Plain LCS diff. `startOldLine`/`startNewLine` let a caller diff a windowed
 * excerpt of a larger file while still reporting the file's real line
 * numbers (see `anchorEdit` below).
 */
export function diffLines(oldText: string, newText: string, startOldLine = 1, startNewLine = 1): DiffHunk {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;

  // dp[i][j] = length of the LCS of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldLineNo = startOldLine;
  let newLineNo = startNewLine;
  let addCount = 0;
  let removeCount = 0;

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'context', text: a[i]!, oldLineNo, newLineNo });
      i++;
      j++;
      oldLineNo++;
      newLineNo++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push({ kind: 'remove', text: a[i]!, oldLineNo, newLineNo: null });
      i++;
      oldLineNo++;
      removeCount++;
    } else {
      lines.push({ kind: 'add', text: b[j]!, oldLineNo: null, newLineNo });
      j++;
      newLineNo++;
      addCount++;
    }
  }
  while (i < n) {
    lines.push({ kind: 'remove', text: a[i]!, oldLineNo, newLineNo: null });
    i++;
    oldLineNo++;
    removeCount++;
  }
  while (j < m) {
    lines.push({ kind: 'add', text: b[j]!, oldLineNo: null, newLineNo });
    j++;
    newLineNo++;
    addCount++;
  }

  return { lines, addCount, removeCount };
}

const CONTEXT_LINES = 3;

export type AnchorResult =
  | { contextUnavailable: false; startOldLine: number; hunk: DiffHunk }
  | { contextUnavailable: true; reason: 'not_cached' | 'zero_occurrences' | 'multiple_occurrences' };

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + 1);
  }
  return count;
}

/**
 * `old_string` is a fragment, not a file (the plan's central correctness
 * rule). This locates it as a literal substring of a cached file version and
 * diffs a windowed region around it so the result carries real line numbers
 * and real surrounding context.
 *
 * `old_string` uniqueness is an SDK invariant, not one a possibly-stale
 * *client* cache may assume — zero or multiple occurrences must never
 * fabricate a line number that looks real. Both report `contextUnavailable`
 * instead.
 */
export function anchorEdit(cachedContent: string | null, oldString: string, newString: string): AnchorResult {
  if (cachedContent === null) return { contextUnavailable: true, reason: 'not_cached' };

  const occurrences = countOccurrences(cachedContent, oldString);
  if (occurrences === 0) return { contextUnavailable: true, reason: 'zero_occurrences' };
  if (occurrences > 1) return { contextUnavailable: true, reason: 'multiple_occurrences' };

  const matchStart = cachedContent.indexOf(oldString);
  const before = cachedContent.slice(0, matchStart);
  const matchStartLine = before.split('\n').length; // 1-based
  const oldStringLineCount = oldString.split('\n').length;

  const allLines = cachedContent.split('\n');
  const windowStartLine = Math.max(1, matchStartLine - CONTEXT_LINES);
  const windowEndLine = Math.min(allLines.length, matchStartLine + oldStringLineCount - 1 + CONTEXT_LINES);

  const beforeContext = allLines.slice(windowStartLine - 1, matchStartLine - 1).join('\n');
  const afterContext = allLines.slice(matchStartLine - 1 + oldStringLineCount, windowEndLine).join('\n');

  const windowOld = [beforeContext, oldString, afterContext].filter((piece) => piece !== '').join('\n');
  const windowNew = [beforeContext, newString, afterContext].filter((piece) => piece !== '').join('\n');

  const hunk = diffLines(windowOld, windowNew, windowStartLine, windowStartLine);
  return { contextUnavailable: false, startOldLine: windowStartLine, hunk };
}
