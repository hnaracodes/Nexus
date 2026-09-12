import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Packaging settings that decide whether a DOWNLOADED build opens at all.
 *
 * v0.2.3 and v0.3.0 both shipped unopenable. With no signing identity,
 * electron-builder left stock Electron's linker signature on the executable and
 * never sealed the bundle:
 *
 *   Identifier=Electron            (not dev.syncode.desktop)
 *   Sealed Resources=none
 *   $ codesign --verify --deep --strict SynCode.app
 *   code has no resources but signature indicates they must be present
 *
 * On Apple Silicon that plus the quarantine flag a browser sets is reported as
 * "SynCode is damaged and can't be opened" — a HARD failure that right-click →
 * Open cannot clear, unlike the "Apple could not verify" warning the download
 * page describes. Local builds looked fine because a file that was never
 * downloaded is never quarantined, so nothing in this repo noticed for two
 * releases.
 *
 * These are config assertions rather than behaviour tests on purpose: the
 * behaviour needs a Mac, a real package run and a quarantine attribute, which
 * CI on three platforms cannot do. What they CAN do is fail the moment someone
 * deletes the hook or re-enables hardened runtime without a certificate.
 */
const config = readFileSync(join(__dirname, '..', 'electron-builder.yml'), 'utf8');

describe('macOS packaging', () => {
  it('runs the ad-hoc signing hook, without which a downloaded build is "damaged"', () => {
    expect(config).toMatch(/^afterPack:\s*build\/adhoc-sign\.cjs\s*$/m);
  });

  it('keeps hardened runtime off while there is no Developer ID', () => {
    // Hardened runtime is only meaningful with notarization, needs an
    // entitlements file Electron is particular about, and buys nothing over an
    // ad-hoc signature except new ways to fail to launch.
    expect(config).toMatch(/hardenedRuntime:\s*false/);
  });

  it('still names the app by productName, not the npm scope', () => {
    // The npm scope has leaked into user-visible identity three times already.
    expect(config).toMatch(/^productName:\s*SynCode\s*$/m);
    expect(config).toMatch(/^\s*executableName:\s*syncode\s*$/m);
    expect(config).toMatch(/^appId:\s*dev\.syncode\.desktop\s*$/m);
  });
});
