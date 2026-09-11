#!/usr/bin/env node
// Tests for scripts/install.sh.
//
// Not wired into `npm run verify` — this unit (phase 17e) does not own
// package.json's script list, and adding a new top-level script there risks
// colliding with sibling units editing the same file concurrently (CLAUDE.md
// §9). Run directly:
//
//   node scripts/install.test.mjs
//
// It never touches the real network or the real filesystem outside a temp
// directory: `curl` and `uname` are replaced on PATH with small fakes, and
// install.sh's own install-destination env vars are pointed at a scratch
// directory instead of /Applications or ~/.local/bin.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALL_SH = fileURLToPath(new URL('./install.sh', import.meta.url));

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Builds an isolated sandbox: a fake `curl` and `uname` on PATH, a GitHub
 * release JSON fixture whose asset URLs are `file://` paths into the sandbox
 * (the fake curl just `cp`s/`cat`s them — no real network), and env
 * overrides so install.sh writes its "installed" artifact into a scratch dir
 * instead of a real system location.
 */
function makeSandbox({ platformOs, platformArch, assetBytes, checksumLine, assetArchTag }) {
  const root = mkdtempSync(join(tmpdir(), 'nexus-install-test-'));
  const bin = join(root, 'bin');
  const fixtures = join(root, 'fixtures');
  const scratch = join(root, 'scratch');
  mkdirSync(bin, { recursive: true });
  mkdirSync(fixtures, { recursive: true });
  mkdirSync(scratch, { recursive: true });

  const ext = platformOs === 'Darwin' ? 'dmg' : 'AppImage';
  // `assetArchTag` overrides how the arch is spelled IN THE FILENAME, which is
  // not always how `uname -m` spells it. electron-builder emits
  // `...-mac-x64.dmg` but `...-linux-x86_64.AppImage` from the one
  // `artifactName` template, and this fixture used to hardcode `x64` for both —
  // the same assumption install.sh made, which is precisely why every test
  // passed while a real x86_64 Linux user was told no build existed.
  const archTag =
    assetArchTag ?? (platformArch === 'arm64' || platformArch === 'aarch64' ? 'arm64' : 'x64');
  const assetName = `Nexus-9.9.9-${platformOs === 'Darwin' ? 'mac' : 'linux'}-${archTag}.${ext}`;
  const checksumName = `${assetName}.sha256`;

  const assetPath = join(fixtures, assetName);
  writeFileSync(assetPath, assetBytes);

  const checksumPath = join(fixtures, checksumName);
  const line = checksumLine ?? `${sha256Hex(assetBytes)}  ${assetName}\n`;
  writeFileSync(checksumPath, line);

  const releaseJson = {
    tag_name: 'v9.9.9',
    html_url: 'https://github.com/hnaracodes/Nexus/releases/tag/v9.9.9',
    assets: [
      { name: assetName, browser_download_url: `file://${assetPath}`, size: assetBytes.length },
      { name: checksumName, browser_download_url: `file://${checksumPath}`, size: line.length },
    ],
  };
  const releaseJsonPath = join(fixtures, 'release.json');
  writeFileSync(releaseJsonPath, JSON.stringify(releaseJson, null, 2));

  // Pretty-printed on purpose (see install.sh's comment on why) — matches
  // what the real GitHub API actually returns and what install.sh's grep
  // pipeline is written against.

  const fakeCurl = `#!/bin/sh
set -eu
if [ "\${1:-}" != "-fsSL" ]; then
  echo "fake curl: expected -fsSL first, got: $*" >&2
  exit 2
fi
shift
if [ "\${1:-}" = "-o" ]; then
  dest="$2"
  url="$3"
  cp "\${url#file://}" "$dest"
else
  url="$1"
  case "$url" in
    *"/releases/latest") cat "${releaseJsonPath}" ;;
    *) echo "fake curl: unexpected GET $url" >&2; exit 22 ;;
  esac
fi
`;
  const curlPath = join(bin, 'curl');
  writeFileSync(curlPath, fakeCurl);
  chmodSync(curlPath, 0o755);

  const fakeUname = `#!/bin/sh
case "\${1:-}" in
  -s) echo "${platformOs}" ;;
  -m) echo "${platformArch}" ;;
  *) exit 1 ;;
esac
`;
  const unamePath = join(bin, 'uname');
  writeFileSync(unamePath, fakeUname);
  chmodSync(unamePath, 0o755);

  // A fake `hdiutil` so the macOS branch (mount -> find .app -> cp -> detach)
  // can run all the way through in a test: the real `hdiutil` cannot mount
  // arbitrary bytes as a disk image, so without this the macOS branch always
  // dies at `hdiutil attach` before reaching the code that prints the
  // unsigned-build warning. `attach` drops a fake Nexus.app into the
  // already-created mountpoint dir instead of actually mounting anything;
  // `detach` is a no-op. Harmless on the Linux tests, which never invoke it.
  const fakeHdiutil = `#!/bin/sh
set -eu
cmd="\${1:-}"
shift || true
case "$cmd" in
  attach)
    mountpoint=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -mountpoint)
          mountpoint="$2"
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done
    if [ -z "$mountpoint" ]; then
      echo "fake hdiutil attach: no -mountpoint given" >&2
      exit 1
    fi
    mkdir -p "$mountpoint/Nexus.app/Contents/MacOS"
    exit 0
    ;;
  detach)
    exit 0
    ;;
  *)
    echo "fake hdiutil: unsupported subcommand '$cmd'" >&2
    exit 1
    ;;
esac
`;
  const hdiutilPath = join(bin, 'hdiutil');
  writeFileSync(hdiutilPath, fakeHdiutil);
  chmodSync(hdiutilPath, 0o755);

  return { root, bin, scratch, assetName, checksumName, assetPath, checksumPath, releaseJsonPath };
}

function runInstallSh(sandbox, extraEnv = {}) {
  const env = {
    ...process.env,
    PATH: `${sandbox.bin}:${process.env.PATH}`,
    NEXUS_INSTALL_APPLICATIONS_DIR: sandbox.scratch,
    NEXUS_INSTALL_BIN_DIR: sandbox.scratch,
    ...extraEnv,
  };
  return spawnSync('sh', [INSTALL_SH], { env, encoding: 'utf8' });
}

function cleanup(sandbox) {
  rmSync(sandbox.root, { recursive: true, force: true });
}

let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

// --- the required test: refuses on checksum mismatch -----------------------
test('refuses to install when the downloaded file does not match its published checksum', () => {
  const assetBytes = Buffer.from('this is the real Nexus build, honest');
  const sandbox = makeSandbox({
    platformOs: 'Linux',
    platformArch: 'x86_64',
    assetBytes,
    // Deliberately wrong hash — 64 hex chars that do not match assetBytes.
    checksumLine: `${'0'.repeat(64)}  Nexus-9.9.9-linux-x64.AppImage\n`,
  });
  try {
    const result = runInstallSh(sandbox);
    assert.notEqual(result.status, 0, 'install.sh must exit non-zero on a checksum mismatch');
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /checksum mismatch/i);
    // The whole point: it must not have gone on to "install" the unverified file.
    const scratchContents = readdirSync(sandbox.scratch);
    assert.deepEqual(scratchContents, [], 'nothing should be written to the install dir on refusal');
  } finally {
    cleanup(sandbox);
  }
});

// --- refuses when no checksum was published at all --------------------------
test('refuses to install when the release has no published checksum for the matched asset', () => {
  const assetBytes = Buffer.from('another real-looking build');
  const sandbox = makeSandbox({ platformOs: 'Linux', platformArch: 'x86_64', assetBytes });
  // Remove the checksum asset from the release JSON entirely.
  const releaseJson = JSON.parse(readFileSync(sandbox.releaseJsonPath, 'utf8'));
  releaseJson.assets = releaseJson.assets.filter((a) => !a.name.endsWith('.sha256'));
  writeFileSync(sandbox.releaseJsonPath, JSON.stringify(releaseJson, null, 2));
  try {
    const result = runInstallSh(sandbox);
    assert.notEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /no published checksum|checksum/i);
    assert.deepEqual(readdirSync(sandbox.scratch), []);
  } finally {
    cleanup(sandbox);
  }
});

// --- refuses cleanly on an unsupported OS -----------------------------------
test('refuses on an unsupported OS instead of guessing', () => {
  const assetBytes = Buffer.from('irrelevant');
  const sandbox = makeSandbox({ platformOs: 'Linux', platformArch: 'x86_64', assetBytes });
  // Overwrite the fake uname to report an OS install.sh does not support.
  const unamePath = join(sandbox.bin, 'uname');
  writeFileSync(
    unamePath,
    `#!/bin/sh\ncase "\${1:-}" in -s) echo SunOS ;; -m) echo sparc ;; *) exit 1 ;; esac\n`,
  );
  chmodSync(unamePath, 0o755);
  try {
    const result = runInstallSh(sandbox);
    assert.notEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /only supports macos and linux|unsupported/i);
  } finally {
    cleanup(sandbox);
  }
});

// --- happy path: matching checksum actually installs ------------------------
// Exercised on the Linux branch regardless of the host OS running this test
// suite, because that branch is plain file operations (mkdir/cp/chmod) with
// no OS-specific tooling (unlike the macOS branch's real `hdiutil`), so
// faking `uname` to say Linux is sufficient without needing a real disk image.
test('installs to the overridden directory when the checksum matches', () => {
  const assetBytes = Buffer.from('a verified, correctly-shaped Nexus build');
  const sandbox = makeSandbox({ platformOs: 'Linux', platformArch: 'x86_64', assetBytes });
  try {
    const result = runInstallSh(sandbox);
    assert.equal(result.status, 0, `expected success, got:\n${result.stdout}\n${result.stderr}`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /checksum verified/i);
    const installed = join(sandbox.scratch, 'Nexus.AppImage');
    assert.ok(existsSync(installed), 'expected Nexus.AppImage in the overridden install dir');
  } finally {
    cleanup(sandbox);
  }
});

// --- honesty: prints the unsigned warning even on a clean install ------------
// A fake `hdiutil` (see makeSandbox) stands in for the real one so this test
// can drive the macOS branch all the way to a successful install instead of
// stopping at the checksum stage — the point of this test is specifically
// the warning that prints AFTER a successful hdiutil attach/detach, and a
// green exit status alongside it.
test('prints the unsigned-build warning even when everything succeeds', () => {
  const assetBytes = Buffer.from('macOS-shaped build bytes');
  const sandbox = makeSandbox({ platformOs: 'Darwin', platformArch: 'arm64', assetBytes });
  try {
    const result = runInstallSh(sandbox);
    assert.equal(result.status, 0, `expected success, got:\n${result.stdout}\n${result.stderr}`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /checksum verified/i);
    assert.match(output, /this build is unsigned and not notarized/i);
    assert.match(output, /Apple could not verify that 'Nexus' is free of malware/);
    const installed = join(sandbox.scratch, 'Nexus.app');
    assert.ok(existsSync(installed), 'expected Nexus.app in the overridden install dir');
  } finally {
    cleanup(sandbox);
  }
});

// --- the arch is not spelled the same way twice ------------------------------
// electron-builder produces `Nexus-0.2.3-mac-x64.dmg` and
// `Nexus-0.2.3-linux-x86_64.AppImage` from ONE `artifactName` template, because
// AppImage uses uname's spelling. install.sh normalised `uname -m` to `x64` and
// grepped for that, so on real x86_64 Linux it reported
//
//   error: No linux/x64 build was found in the latest release.
//
// against a release that contained exactly that build. Every test passed
// because this file's fixture spelled the filename `x64` too — the test and
// the code shared one wrong belief, which is the only kind of bug a test suite
// cannot see. Caught by running the installer against the first real release.
test('finds a linux build whose filename spells the arch x86_64, not x64', () => {
  const assetBytes = Buffer.from('an AppImage named the way electron-builder really names them');
  const sandbox = makeSandbox({
    platformOs: 'Linux',
    platformArch: 'x86_64',
    assetArchTag: 'x86_64',
    assetBytes,
  });
  try {
    const result = runInstallSh(sandbox);
    assert.equal(result.status, 0, `expected success, got:\n${result.stdout}\n${result.stderr}`);
    assert.ok(
      existsSync(join(sandbox.scratch, 'Nexus.AppImage')),
      'expected the x86_64-named AppImage to be found and installed',
    );
  } finally {
    cleanup(sandbox);
  }
});

// The mirror of the above: an arm64 machine must NOT match an x86_64 asset just
// because the pattern got looser. Widening a matcher is how you turn "found
// nothing" into "found the wrong thing", which is worse.
test('does not hand an arm64 machine an x86_64 build', () => {
  const assetBytes = Buffer.from('x86_64 bytes that must not reach an arm64 machine');
  const sandbox = makeSandbox({
    platformOs: 'Linux',
    platformArch: 'aarch64',
    assetArchTag: 'x86_64',
    assetBytes,
  });
  try {
    const result = runInstallSh(sandbox);
    assert.notEqual(result.status, 0, 'expected a refusal, not an install');
    assert.match(`${result.stdout}\n${result.stderr}`, /No linux\/arm64 build was found/i);
  } finally {
    cleanup(sandbox);
  }
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log('\nall install.sh tests passed');
}

