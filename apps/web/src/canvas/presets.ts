/**
 * One-click agent presets. A preset is NOT a new kind of thing: it is the body
 * of an ordinary saved agent config (`agentConfig.ts`'s allow-list: name,
 * description, prompt, tools — nothing else). `provider` is deliberately not
 * here: it lives on a graph node / crew member, never on a config.
 *
 * `tools` is what the preset REQUESTS. The room may narrow it and, today, the
 * server does not enforce it on a hand-spawned agent — so no copy anywhere may
 * promise a read-only guarantee.
 */
export interface Preset {
  key: string;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
}

export const PRESETS: readonly Preset[] = [
  {
    key: 'planner',
    name: 'Planner',
    description: 'Breaks a goal into a short, ordered plan. Reads code, does not edit it.',
    prompt:
      'You are the Planner. Read the relevant code, then produce a short numbered plan: what to change, in which files, in what order, and how to check each step. Do not edit files. Finish with the plan only.',
    tools: ['Read', 'Glob', 'Grep'],
  },
  {
    key: 'coder',
    name: 'Coder',
    description: 'Implements the plan or task with small, focused edits.',
    prompt:
      'You are the Coder. Implement the task you are given with the smallest correct change. Follow the existing code style. Summarise exactly what you changed and why when you finish.',
    tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
  },
  {
    key: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews a change for bugs and risk. Reads, does not edit.',
    prompt:
      'You are the Reviewer. Inspect the change you are given for bugs, missing edge cases and risky behaviour. List concrete findings with file and line, most severe first. Do not edit files.',
    tools: ['Read', 'Glob', 'Grep'],
  },
  {
    key: 'tester',
    name: 'Tester',
    description: 'Writes and runs tests for the change.',
    prompt:
      'You are the Tester. Write or extend tests for the change you are given, run them, and report which pass and which fail, with the failure output for any that fail.',
    tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
  },
];

export interface ConfigBody {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  model?: string;
  mcpServers?: Record<string, unknown>;
  agents?: Record<string, unknown>;
}

export function presetConfigBody(p: Preset): ConfigBody {
  return { name: p.name, description: p.description, prompt: p.prompt, tools: [...p.tools] };
}

export function findPreset(key: string): Preset | undefined {
  return PRESETS.find((p) => p.key === key);
}

/** The wire caps a display name at 80 chars (`wire.ts`). */
export const MAX_NAME = 80;

/** `base`, then `base 2`, `base 3`... first not taken (case-insensitive),
 *  truncated so the result is never longer than 80 characters. */
export function uniqueName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  const clip = (s: string, suffix: string): string => s.slice(0, MAX_NAME - suffix.length) + suffix;
  const first = clip(base, '');
  if (!used.has(first.toLowerCase())) return first;
  for (let n = 2; ; n += 1) {
    const candidate = clip(base, ` ${n}`);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
