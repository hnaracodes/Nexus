// Written as `preload.cts`, not `preload.ts`, so `tsc` always emits CommonJS
// (`dist/preload.cjs`) regardless of this package's own `"type": "module"`.
// TypeScript's Node16/NodeNext module modes treat `.cts` as "always
// CommonJS" independent of the nearest package.json — this is the one file
// in the app where that matters: Electron's preload sandbox has, across its
// history, been the one place where ESM support has been the least reliable
// bet (main-process ESM is solid; contextIsolation + sandbox + ESM preload
// has shifted between versions). CommonJS preload with contextBridge has
// worked unchanged since context isolation was introduced, so this is not a
// place to gamble on the current Electron version's ESM support — get it
// wrong here and the whole window fails to load with no visible error.
//
// Minimal on purpose: the renderer is the SAME web app already served in a
// plain browser tab (see main.ts and CLAUDE.md's phase-9a plan), and it
// never needed a JS bridge into Node — it talks to a room over fetch() and a
// WebSocket, identically to https://nexus-mvp.fly.dev/. Exposing capability
// through contextBridge that the browser build doesn't have and doesn't
// need would just be a second, untested attack surface for no product
// benefit, so this exposes nothing except a version string — useful for
// support requests ("what desktop build is this") and nothing else.
import { contextBridge } from 'electron';

// `app.getVersion()` is a main-process-only API — `app` is not one of the
// Electron modules exposed inside a preload script at all, sandboxed or
// not — so main.ts passes it in as a plain argv flag via the documented
// `additionalArguments` webPreference instead of over IPC, and this just
// reads it back. `process.argv` (unlike most of Node) stays available to a
// preload script even under a full sandbox, which is exactly why Electron
// documents `additionalArguments` as the way to hand a sandboxed preload
// static configuration a main process already knows.
const versionFlag = 'nexus-app-version=';
const versionArg = process.argv.find((arg) => arg.startsWith(`--${versionFlag}`));
const version = versionArg !== undefined ? versionArg.slice(2 + versionFlag.length) : 'dev';

contextBridge.exposeInMainWorld('nexusDesktop', { version });
