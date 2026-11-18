#!/usr/bin/env node
// Phase 19b. node-pty 1.1.0 publishes its macOS `spawn-helper` WITHOUT the
// execute bit, so every spawn fails with "posix_spawnp failed". Found by
// spawning a shell straight after install. Fixed here, at install time,
// because the packaged app copies node_modules' permissions as they are — and
// changing files inside a signed .app at runtime would break its seal (the
// "damaged" failure CLAUDE.md §9 already records).
//
// Tolerant on purpose: node-pty is an OPTIONAL dependency of the desktop app
// and is legitimately absent in the server's Docker image and on any machine
// where its native build failed. Absent means nothing to fix, never an error.
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const prebuilds = join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds');
if (existsSync(prebuilds)) {
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, 'spawn-helper');
    if (!existsSync(helper)) continue;
    const mode = statSync(helper).mode;
    if ((mode & 0o111) !== 0o111) {
      chmodSync(helper, mode | 0o755);
      console.log(`fix-node-pty-perms: made ${platform}/spawn-helper executable`);
    }
  }
}
