/**
 * Phase 19b — the desktop's terminal capability. This file is the ONLY place
 * SynCode touches node-pty; the server receives a `PtyFactory` and never
 * imports it, which is what keeps terminals off the hosted site by
 * construction (see apps/server/src/server/terminals.ts).
 *
 * node-pty is an OPTIONAL dependency: its native build is legitimately absent
 * in the server's Docker image and wherever compilation failed. Absent means
 * this desktop simply has no terminals — never a crash at startup.
 */
import type { PtyFactory } from '@syncode/server';

type NodePty = typeof import('node-pty');

/**
 * The environment a terminal's shell starts with: the host's own, because "run
 * my scripts against my code" needs the host's tools and credentials — minus
 * SynCode's own settings, which are this process's business, not the shell's.
 */
export function shellEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.startsWith('SYNCODE_') || key.startsWith('NEXUS_')) continue;
    // Electron sets this for its own child processes; a shell inheriting it
    // would make every `node` it runs behave like Electron-as-node.
    if (key === 'ELECTRON_RUN_AS_NODE') continue;
    out[key] = value;
  }
  out['TERM'] = 'xterm-256color';
  out['COLORTERM'] = 'truecolor';
  return out;
}

export function createNodePtyFactory(
  pty: NodePty,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PtyFactory {
  return ({ cwd, cols, rows }) => {
    // A LOGIN shell on macOS/Linux: an app launched from the Dock gets a thin
    // PATH (the "spawn node ENOENT" lesson in CLAUDE.md §9), and `-l` makes
    // the shell read the host's profile, so nvm, Homebrew and the rest are
    // there exactly as in their own terminal.
    const shell = platform === 'win32' ? 'powershell.exe' : (env['SHELL'] ?? '/bin/zsh');
    const args = platform === 'win32' ? [] : ['-l'];
    const proc = pty.spawn(shell, args, { name: 'xterm-256color', cwd, cols, rows, env: shellEnv(env) });
    return {
      onData: (listener) => void proc.onData(listener),
      onExit: (listener) => void proc.onExit(({ exitCode }) => listener({ exitCode })),
      write: (data) => proc.write(data),
      resize: (c, r) => proc.resize(c, r),
      kill: () => proc.kill(),
    };
  };
}

/** The factory, or undefined when node-pty is not available on this machine. */
export async function loadPtyFactory(env: NodeJS.ProcessEnv = process.env): Promise<PtyFactory | undefined> {
  try {
    const pty = (await import('node-pty')) as NodePty & { default?: NodePty };
    return createNodePtyFactory(pty.default ?? pty, env);
  } catch (error) {
    console.warn('terminals unavailable: node-pty did not load', error instanceof Error ? error.message : error);
    return undefined;
  }
}
