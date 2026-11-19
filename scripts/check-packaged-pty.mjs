#!/usr/bin/env node
// Proves a PACKAGED app's terminal works: loads the node-pty that ships inside
// the built app, starts a real shell with it, and waits for the shell to
// answer. The release workflow runs it on every OS after packaging.
//
//   node scripts/check-packaged-pty.mjs <path to the packaged node-pty> [--max-glibc 2.35]
//
// Why it exists: v0.5.0's Linux AppImage built green and shipped a terminal
// that could not load on almost any Linux machine. GitHub's `ubuntu-latest`
// had moved to glibc 2.42, whose `cfsetospeed`/`cfsetispeed` carry a new
// symbol version, so the node-pty compiled there demanded GLIBC_2.42 — and
// Ubuntu 24.04 (2.39) and Debian 12 (2.36) refused it. Nothing had ever loaded
// the packaged binary. `--max-glibc` makes that a build failure on Linux.
//
// Fails loudly on every path that cannot prove the point: a missing
// directory, no ELF module to inspect, or a shell that never answers.
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/** Numeric dotted-version compare: <0, 0, >0. "2.10" is newer than "2.9". */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The highest glibc version a shared object asks for, or null. An ELF keeps
 * every symbol version it needs as a literal string ("GLIBC_2.34") in its
 * dynamic string table, so reading those names is what `strings | grep GLIBC`
 * does — no objdump needed, and fakeable in a test.
 */
export function highestGlibc(buffer) {
  const versions = buffer.toString('latin1').match(/GLIBC_\d+(?:\.\d+)+/g) ?? [];
  let highest = null;
  for (const v of versions) {
    const version = v.slice('GLIBC_'.length);
    if (highest === null || compareVersions(version, highest) > 0) highest = version;
  }
  return highest;
}

/** Every `*.node` file under `dir` that is an ELF (Linux) binary. */
export function findElfModules(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findElfModules(path));
    } else if (entry.isFile() && entry.name.endsWith('.node')) {
      const head = readFileSync(path).subarray(0, 4);
      if (head.equals(ELF_MAGIC)) found.push(path);
    }
  }
  return found.sort();
}

/**
 * Starts the platform's shell through the node-pty in `ptyDir` and resolves
 * once it prints `computed-42`. The command typed is `6*7` arithmetic, never
 * the literal answer, so the terminal echoing the keystrokes cannot pass this:
 * only a shell that actually ran the command can.
 */
export function checkShell(ptyDir, { timeoutMs = 30_000, platform = process.platform, command } = {}) {
  const require = createRequire(join(resolve(ptyDir), 'package.json'));
  const pty = require(resolve(ptyDir));
  const windows = platform === 'win32';
  // Matches apps/desktop/src/pty.ts: powershell on Windows, a POSIX shell elsewhere.
  const shell = windows ? 'powershell.exe' : '/bin/sh';
  const args = windows ? ['-NoLogo', '-NoProfile'] : [];
  const typed = command ?? (windows ? 'Write-Output ("computed-" + (6*7))\r' : 'echo computed-$((6*7))\r');

  return new Promise((resolvePromise, reject) => {
    const proc = pty.spawn(shell, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
    let output = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc.kill();
      } catch {
        // already gone
      }
      if (error) reject(error);
      else resolvePromise({ shell, output });
    };
    const timer = setTimeout(
      () => finish(new Error(`${shell} did not answer within ${timeoutMs} ms. Last output: ${JSON.stringify(output.slice(-300))}`)),
      timeoutMs,
    );
    proc.onData((data) => {
      output += data;
      if (output.includes('computed-42')) finish(null);
    });
    proc.onExit(({ exitCode }) => {
      if (!output.includes('computed-42')) finish(new Error(`${shell} exited (code ${exitCode}) before answering. Output: ${JSON.stringify(output.slice(-300))}`));
    });
    proc.write(typed);
  });
}

function fail(message) {
  console.error(`check-packaged-pty: FAIL — ${message}`);
  process.exit(1);
}

async function main(argv) {
  const [dir, ...rest] = argv;
  if (!dir) fail('usage: check-packaged-pty.mjs <node-pty dir> [--max-glibc X.Y]');
  const flag = rest.indexOf('--max-glibc');
  const maxGlibc = flag === -1 ? null : rest[flag + 1];
  if (flag !== -1 && !/^\d+\.\d+$/.test(maxGlibc ?? '')) fail('--max-glibc needs a version like 2.35');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`node-pty directory not found: ${dir}`);

  if (maxGlibc !== null) {
    const modules = findElfModules(dir);
    if (modules.length === 0) fail(`no ELF native module under ${dir} — nothing to check against glibc ${maxGlibc}`);
    for (const path of modules) {
      const needs = highestGlibc(readFileSync(path));
      if (needs !== null && compareVersions(needs, maxGlibc) > 0) {
        fail(`${path} needs GLIBC ${needs}, newer than the ${maxGlibc} ceiling — it will not load on older Linux. Build on an older runner image.`);
      }
      console.log(`check-packaged-pty: ${path} needs GLIBC ${needs ?? '(none)'} (ceiling ${maxGlibc}) ok`);
    }
  }

  try {
    const { shell } = await checkShell(dir);
    console.log(`check-packaged-pty: ${shell} answered computed-42 through ${dir}`);
    process.exit(0); // a pty handle can keep the event loop alive on Windows
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
