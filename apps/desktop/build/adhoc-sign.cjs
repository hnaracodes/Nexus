'use strict';
const { execFileSync } = require('node:child_process');

/**
 * Ad-hoc sign the macOS bundle when there is no Developer ID to sign it with.
 *
 * WITHOUT THIS THE APP IS NOT MERELY UNTRUSTED, IT IS BROKEN. With no signing
 * identity, electron-builder leaves stock Electron's own linker signature on
 * the main executable and never seals the bundle, so the shipped v0.3.0 app
 * reported:
 *
 *   Identifier=Electron            <- not dev.syncode.desktop
 *   Sealed Resources=none
 *   $ codesign --verify --deep --strict SynCode.app
 *   code has no resources but signature indicates they must be present
 *
 * On Apple Silicon an unsealed bundle carrying the quarantine flag is rejected
 * outright, and macOS words that as "SynCode is damaged and can't be opened.
 * You should move it to the Trash." That is a different failure from the
 * expected "Apple could not verify..." — and, critically, right-click → Open
 * does NOT rescue it. Every download of v0.2.3 and v0.3.0 was unopenable, and
 * local builds looked fine only because a file that was never downloaded never
 * gets quarantined.
 *
 * `codesign --sign -` is an ad-hoc signature: no certificate, no identity, no
 * trust — but a VALID, sealed bundle with our own appId. Gatekeeper then gives
 * the ordinary unsigned-developer warning that right-click → Open clears, which
 * is what the download page has been promising all along.
 *
 * Skipped when CSC_LINK is set, because that means a real certificate exists
 * and electron-builder's own signing path should own it.
 */
exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK) {
    console.log('adhoc-sign: CSC_LINK is set — leaving signing to electron-builder.');
    return;
  }
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = `${context.appOutDir}/${appName}`;

  // --deep is deprecated for real signing but is correct here: every nested
  // helper and framework needs a signature too, and with no identity there is
  // no per-component entitlement story to get right.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });

  // Fail the BUILD rather than publish another unopenable dmg. This project
  // has already shipped two releases that could not be opened at all.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`adhoc-sign: ${appName} is ad-hoc signed and verifies.`);
};
