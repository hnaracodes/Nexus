import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { BrowserWindow, app, shell } from 'electron';
// The specifier below has no real "exports" entry backing it — see
// src/nexus-server.d.ts for why this exact subpath is both what typechecks
// (an ambient declaration) and what actually resolves at runtime once
// `npm run build -w @nexus/server` has produced dist/server/index.js.
import { createServer } from '@nexus/server/dist/server/index.js';
import { resolveListenPort, serverOrigin } from './serverHost.js';
import { isAllowedNavigation } from './navigationGuard.js';

// One process, one server, one room — this file never calls createServer()
// more than once. Invariant I1 is about a room owning exactly one live
// query(), and while the desktop shell only ever runs a single room per
// process, restarting the HTTP server on, say, a macOS "activate" after
// every window closed would still be pointless work and a second listener
// racing the first for the same in-memory room registry. `origin` is
// resolved once in `main()` and every window this process ever opens reuses
// it.
let httpServer: Server | undefined;

async function startBackend(): Promise<string> {
  // Port 0 hands port selection to the OS. This repo has already hit the
  // consequence of assuming a fixed port is free — CLAUDE.md documents 8080
  // being occupied by an unrelated process on the primary dev machine — and
  // a desktop app installed on an arbitrary user's machine has even less
  // basis to assume any particular port is open. `server.address()` after
  // 'listening' is the only way back to whichever port the OS actually
  // handed out; see serverHost.ts for why that call needs its own helper
  // rather than being inlined here.
  const { server } = createServer();
  httpServer = server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return serverOrigin(resolveListenPort(server.address()));
}

function createWindow(origin: string): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      // The renderer here is the existing web app (apps/web), served over
      // plain HTTP by the server this process just started — it talks to a
      // room over fetch()/WebSocket exactly like a browser tab, and has no
      // reason to touch Node or Electron APIs. contextIsolation + a
      // deliberately empty-of-capability preload (see preload.cts) is the
      // whole security story for this window; there is no product feature
      // here that would justify nodeIntegration.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      // See preload.cts: this is how a main-process-only value (the packaged
      // app's version) reaches a sandboxed preload without IPC.
      additionalArguments: [`--nexus-app-version=${app.getVersion()}`],
    },
  });

  // This window's only legitimate destination is the server's own origin.
  // Anything else — a link pasted into the transcript, a target="_blank"
  // from rendered markdown, a driver-request notice, whatever the room UI
  // grows next — must open in the user's real browser instead of taking
  // over (or replacing) this window's chrome-less webview. isAllowedNavigation
  // is a pure predicate (navigationGuard.ts) precisely so this same check can
  // be exercised by a test without launching Electron at all.
  window.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url, origin)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedNavigation(url, origin)) void shell.openExternal(url);
    // Always 'deny': even a same-origin window.open() gets nothing special
    // here. Nothing in the room UI currently opens same-origin popups, and
    // the moment one does, it should get a deliberate decision, not a
    // silently-allowed second BrowserWindow with no navigation guard of its
    // own.
    return { action: 'deny' };
  });

  void window.loadURL(origin);
}

async function main(): Promise<void> {
  await app.whenReady();
  const origin = await startBackend();
  createWindow(origin);

  app.on('activate', () => {
    // macOS convention: the app (and this process, and the one HTTP server
    // it started) stays alive after every window closes, and clicking the
    // dock icon should bring a window back rather than starting a second
    // server on a second port.
    if (BrowserWindow.getAllWindows().length === 0) createWindow(origin);
  });
}

app.on('window-all-closed', () => {
  // Standard Electron convention, not a Nexus-specific choice: on macOS
  // apps normally stay resident after their last window closes (quit via
  // Cmd+Q or the dock), so quitting here would surprise a mac user for whom
  // the dock icon staying present means "still running". 'before-quit' below
  // is what actually stops the server, on every platform, whichever way the
  // app ends up quitting.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  httpServer?.close();
});

void main().catch((error: unknown) => {
  // Anything thrown before a window ever opens (the port failed to bind, the
  // bundled server dist is missing, …) has nowhere else to go — there is no
  // room UI up yet to show an error banner in. Logging plainly and quitting
  // beats a silently blank or hung window.
  console.error('Nexus desktop failed to start:', error);
  app.quit();
});
