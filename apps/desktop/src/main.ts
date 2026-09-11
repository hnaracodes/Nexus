import { fileURLToPath } from 'node:url';
import { join as joinPath } from 'node:path';
import type { Server } from 'node:http';
import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from 'electron';
import type { MenuItem } from 'electron';
import { resolveListenPort, serverOrigin } from './serverHost.js';
import { isAllowedNavigation } from './navigationGuard.js';
import { parseRoomLink } from './launcher.js';
import { migrateUserData } from './userDataMigration.js';
import {
  folderConsentMessage,
  folderDisplayName,
  lanShareConfirmMessage,
  localNetworkAddresses,
  roomReadyMessage,
} from './folderRoom.js';
import { describeHostConflict } from './hostGuard.js';

// One process, one server, one room — this file never calls createServer()
// more than once. Invariant I1 is about a room owning exactly one live
// query(), and while the desktop shell only ever runs a single room per
// process, restarting the HTTP server on, say, a macOS "activate" after
// every window closed would still be pointless work and a second listener
// racing the first for the same in-memory room registry. `origin` is
// resolved once in `main()` and every window this process ever opens reuses
// it.
//
// "Share on Local Network" (phase 17c) is the one deliberate exception to
// "never restart the server" — it closes and re-listens the SAME Server
// instance on the SAME port, just on 0.0.0.0 instead of 127.0.0.1. That is
// still a single server for a single room's whole life; only which
// interfaces may reach it changes.
//
// This comment used to be aspirational rather than enforced: closing a
// hosted room's window on macOS never quit the process, and the dock icon's
// `activate` opened a fresh join window whose "Open a folder" button called
// `startBackend()` again regardless, silently stranding the first server
// with no window and no way to reach it. `hostedRoom`, `describeHostConflict`
// (hostGuard.ts) and the `activate` handler below are what actually make
// this comment true now: see hostedRoom's own doc comment for the mechanism.
let httpServer: Server | undefined;
/** The port `httpServer` is listening on, once known. Kept so "Share on
 *  Local Network" can re-listen on the SAME port — changing port on rebind
 *  would strand the already-loaded room window, which has that port baked
 *  into every URL and WebSocket reconnect attempt it will ever make. */
let currentPort: number | undefined;
/** Set by `nexus:pick-folder`, read by `nexus:open-folder`. This is the ONE
 *  place a picked folder's real path is remembered — the renderer is handed
 *  back only a display string (see `folderRoom.ts`), never the path itself,
 *  so `nexus:open-folder` cannot be made to open anywhere the OS dialog did
 *  not actually return. Same boundary `parseRoomLink` draws for a pasted
 *  link, applied to a picked folder instead. */
let pendingFolderPath: string | undefined;
/** Set once a local folder room this process is HOSTING has been created.
 *  Absent for a "Join a room" session — there is no server in this process
 *  to share in that case, so the guard below is what keeps "Share on Local
 *  Network" from doing anything when there is nothing local to share.
 *
 *  Also the single fact `describeHostConflict` (hostGuard.ts) and the
 *  `activate` handler below need to close the "second host" hole: as long as
 *  this is set, `nexus:open-folder` refuses to start a second backend, and a
 *  dock-icon `activate` with no windows open reopens THIS room rather than
 *  the join chooser — so there is never a window from which "Open a folder"
 *  for a different folder can even be reached while one is already hosted.
 *  `folderName` is display-only (never re-derived into a path); `url` is the
 *  exact joinable URL `createWindow` was given the first time, so reopening
 *  it lands the user back on the same room rather than a fresh one. */
let hostedRoom: { id: string; token: string; folderName: string; url: string } | undefined;
let sharedOnLan = false;
let shareMenuItem: MenuItem | undefined;
/** The most recently opened room window, so the menu's click handler has a
 *  `BrowserWindow` to parent its dialogs to. Not read from the menu click
 *  callback's own window argument: Electron's `MenuItemConstructorOptions`
 *  types that as the more general `BaseWindow`, which `dialog.showMessageBox`
 *  does not accept, and this app only ever opens `BrowserWindow`s anyway. */
let currentRoomWindow: BrowserWindow | undefined;

/**
 * Point the server's writable paths somewhere a packaged app can actually
 * write, BEFORE `createServer()` reads them.
 *
 * Both defaults — `./work` for room working directories and `./data` for the
 * event log, room sidecars and the config store — are relative, so they resolve
 * against `process.cwd()`. In a packaged macOS app that is `/`, which is not
 * writable. The symptom is not an obvious permissions error either: room
 * creation reports "Could not clone that repository. Check the URL and try
 * again." for a room that named no repository at all, because `mkdirSync`
 * throws inside the clone path's try block.
 *
 * Found by launching the packaged `.dmg` and asking it to make a room — the
 * first thing any user does, and something no test in this repo does, because
 * every test runs from a writable cwd. It is the same class of bug CLAUDE.md
 * already records for `serveStatic` resolving against `process.cwd()`:
 * "works today only because every invocation happens to run from the repo
 * root."
 *
 * `app.getPath('userData')` is Electron's per-user, per-app writable
 * directory (`~/Library/Application Support/SynCode` on macOS), which is also
 * where a user would expect their rooms to survive an app update.
 *
 * Set only when the environment does not already say otherwise, so `npm run
 * dev` from the repo — and anyone debugging with an explicit NEXUS_DATA_DIR —
 * keeps its existing behaviour.
 */
function useWritablePaths(): void {
  /**
   * Name the app BEFORE asking for its userData path.
   *
   * `app.getName()` falls back to package.json's `name`, which here is the npm
   * scope `@syncode/desktop` — and Electron joins that straight into the path, so
   * a user's rooms landed in `~/Library/Application Support/@syncode/desktop/`.
   * Writable, so nothing broke, but a scoped npm name is an implementation
   * detail leaking into a directory a person will actually open in Finder.
   *
   * `productName` in package.json fixes it too and is set alongside this, but
   * the explicit call is what makes it true regardless of how the app is
   * launched — `npm run dev` reads a different package.json context than the
   * packaged bundle does.
   */
  // Where the old name put things, asked of Electron rather than hardcoded, so
  // this is right on Windows (%APPDATA%) and Linux (~/.config) too.
  app.setName('SynCode');
  const legacyUserData = app.getPath('userData');

  app.setName('SynCode');
  const userData = app.getPath('userData');

  migrateUserData(legacyUserData, userData);

  process.env['SYNCODE_DATA_DIR'] ??= joinPath(userData, 'data');
  process.env['SYNCODE_WORKDIR'] ??= joinPath(userData, 'work');
}



async function startBackend(): Promise<{ origin: string; port: number }> {
  useWritablePaths();

  /**
   * Phase 17b/17c: the ONE flag that lets `@syncode/server` accept a
   * `localPath` room-creation request at all (`isLocalHostMode()` in
   * `localHost.ts`) — and, like `useWritablePaths()` immediately above, it
   * MUST be set before the dynamic import below, for the exact same reason
   * documented at length there: a static import would hoist and evaluate
   * `@syncode/server` before this line ever ran, and `isLocalHostMode()`, while
   * it happens to be read at request time rather than frozen into a
   * module-scope constant, is exactly the kind of thing a future edit could
   * "simplify" back to a static import without any test here catching it,
   * since the desktop app has no live browser test of its own to notice a
   * silently-ungated `localPath`. Setting it in this one place, right next to
   * the writable-paths flags this function already exists to set in the
   * correct order, is what keeps that easy to audit. `fly.toml` never sets
   * this — a hosted deployment always reads `isLocalHostMode() === false`.
   */
  process.env['SYNCODE_LOCAL_HOST'] = '1';

  /**
   * DYNAMIC import, and this is load-bearing rather than stylistic.
   *
   * The server captures its writable paths in MODULE-SCOPE constants —
   * `DEFAULT_WORKDIR` in create.ts, `DEFAULT_DATA_DIR` in recovery.ts and
   * configStore.ts, `DATA_DIR_ROOT` in index.ts — all of the form
   * `process.env[...] ?? './work'`. A static `import { createServer } from
   * '@syncode/server'` is hoisted and evaluated before any statement in this
   * file runs, so `useWritablePaths()` above would set the variables AFTER
   * those constants had already been frozen to the unwritable defaults, and
   * the fix would silently do nothing.
   *
   * Importing here, after the environment is set, is the only ordering that
   * works. It cannot be "tidied" back into the import block at the top — that
   * would compile, typecheck, pass every test, and break the packaged app
   * exactly as it was broken before. CLAUDE.md records the same shape for
   * `github.ts`, whose static import in `index.ts` looks removable and is not.
   */
  const { createServer } = await import('@syncode/server');
  // Port 0 hands port selection to the OS. This repo has already hit the
  // consequence of assuming a fixed port is free — CLAUDE.md documents 8080
  // being occupied by an unrelated process on the primary dev machine — and
  // a desktop app installed on an arbitrary user's machine has even less
  // basis to assume any particular port is open. `server.address()` after
  // 'listening' is the only way back to whichever port the OS actually
  // handed out; see serverHost.ts for why that call needs its own helper
  // rather than being inlined here.
  //
  // Always bound to 127.0.0.1 here, never 0.0.0.0 — "Default to
  // loopback-only" (CLAUDE.md). Going wide is exclusively `shareOnLan`'s job,
  // below, as an explicit later action with its own confirmation.
  const { server } = createServer();
  httpServer = server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = resolveListenPort(server.address());
  currentPort = port;
  return { origin: serverOrigin(port), port };
}

function createWindow(origin: string, joinedOrigin?: string): void {
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
    if (isAllowedNavigation(url, origin, joinedOrigin)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedNavigation(url, origin, joinedOrigin)) void shell.openExternal(url);
    // Always 'deny': even a same-origin window.open() gets nothing special
    // here. Nothing in the room UI currently opens same-origin popups, and
    // the moment one does, it should get a deliberate decision, not a
    // silently-allowed second BrowserWindow with no navigation guard of its
    // own.
    return { action: 'deny' };
  });

  /**
   * NAME THE HOST IN THE TITLE BAR when the app has joined someone else's
   * room.
   *
   * This window is chrome-less: there is no address bar, so once it has loaded
   * a remote origin the user has no way to see WHERE they are. A pasted link to
   * `https://nexus-mvp.fly.dev.evil.example` is a well-formed room link to a
   * host we cannot refuse — SynCode is self-hostable, so there is no allow-list
   * of legitimate hosts to check against — and a page there could imitate the
   * room UI and ask for an Anthropic API key.
   *
   * The navigation guard already stops that page walking the window onward.
   * What it cannot do is tell the user which house they are standing in. A
   * title bar is the browser's address bar for a window that has none, and it
   * costs one line.
   *
   * Local rooms keep the plain product name: there is no host worth naming when
   * the server is this process.
   */
  if (joinedOrigin !== undefined) {
    // `setTitle` rather than letting the page's <title> win — a hostile page
    // would happily title itself whatever it liked.
    const host = (() => {
      try {
        return new URL(joinedOrigin).host;
      } catch {
        return joinedOrigin;
      }
    })();
    window.setTitle(`SynCode — connected to ${host}`);
    window.on('page-title-updated', (event) => {
      event.preventDefault();
    });
  }

  void window.loadURL(origin);
  // Tracked so the "Share on Local Network" menu action (phase 17c) has a
  // BrowserWindow to parent its confirmation dialogs to.
  currentRoomWindow = window;
  window.on('closed', () => {
    if (currentRoomWindow === window) currentRoomWindow = undefined;
  });
}


/**
 * The first window the app shows: a local page asking where to go.
 *
 * Loaded with `loadFile` from inside the bundle, NEVER from a server. The page
 * that decides which origin to trust must not itself be served by a candidate
 * origin, or a hostile room controls the screen that vets it.
 */
function createJoinWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 640,
    height: 560,
    resizable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A DIFFERENT preload from the room window's. See joinPreload.cts: this
      // one exposes a single channel, because this page ships with the app.
      // The room window keeps the zero-capability preload.
      preload: fileURLToPath(new URL('./joinPreload.cjs', import.meta.url)),
    },
  });
  void window.loadFile(fileURLToPath(new URL('../join.html', import.meta.url)));
  return window;
}

/**
 * Wire the join screen's two choices.
 *
 * Registered once, in `main()`, before any window exists. `parseRoomLink` is
 * the security boundary and runs HERE, in the main process — the renderer
 * hands over a string and gets a verdict; it never decides what is loaded.
 */
function registerJoinHandlers(getJoinWindow: () => BrowserWindow | null): void {
  ipcMain.handle('nexus:join', (_event, raw: unknown): string | null => {
    if (typeof raw !== 'string') return 'That does not look like a room link.';
    const parsed = parseRoomLink(raw);
    if (!parsed.ok) return parsed.problem;

    // The joined origin is fixed HERE, once, and handed to the window as the
    // single extra destination its guard will permit.
    createWindow(parsed.target.url, parsed.target.origin);
    getJoinWindow()?.close();
    return null;
  });

  /**
   * Step 1 of "Open a folder": show the NATIVE OS picker and remember its
   * result. The renderer gets back only a display string built from that
   * result (`folderConsentMessage`) — never something it typed itself and
   * never something `nexus:open-folder` below will treat as the path to
   * open. That is the same boundary `parseRoomLink` draws for a pasted link,
   * for the same reason: what decides where this app goes must run in the
   * main process, driven by something the OS itself vouched for.
   */
  ipcMain.handle('nexus:pick-folder', async (): Promise<{ consent: string } | null> => {
    const win = getJoinWindow();
    const result =
      win === null
        ? await dialog.showOpenDialog({ properties: ['openDirectory'] })
        : await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    const picked = result.filePaths[0];
    if (result.canceled || picked === undefined) return null;
    pendingFolderPath = picked;
    return { consent: folderConsentMessage(picked) };
  });

  /**
   * Step 2: actually create the room and open it. Takes an API key from the
   * renderer — and NOTHING else naming a path — and uses `pendingFolderPath`
   * set by the picker above. A local room is bound loopback-only until
   * someone explicitly chooses "Share on Local Network" from the app menu
   * (CLAUDE.md: "Default to loopback-only; sharing on the LAN is an
   * explicit, separate click").
   */
  ipcMain.handle('nexus:open-folder', async (_event, rawApiKey: unknown): Promise<string | null> => {
    // Last-line-of-defense, checked BEFORE anything else in this handler:
    // this process hosts at most one room at a time ("One process, one
    // server, one room" — this file's own header). The `activate` handler
    // below is what actually keeps a second folder from being reachable
    // through the UI once one is already hosted (it reopens THIS room
    // instead of the join chooser), but that is a UI-level door, not a
    // security boundary — this check is what actually refuses to call
    // `startBackend()` a second time no matter how this handler gets
    // invoked. See hostGuard.ts for the full scenario this closes.
    const conflict = describeHostConflict(
      hostedRoom === undefined ? undefined : { folderName: hostedRoom.folderName },
    );
    if (conflict.blocked) return conflict.message;

    const localPath = pendingFolderPath;
    if (localPath === undefined) {
      return 'Pick a folder first.';
    }
    const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : '';
    if (apiKey === '') {
      return 'An Anthropic API key is required.';
    }

    let origin: string;
    try {
      ({ origin } = await startBackend());
    } catch {
      return 'Could not start the local server.';
    }

    let response: Response;
    try {
      response = await fetch(`${origin}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey, localPath }),
      });
    } catch {
      return 'Could not reach the local server.';
    }

    const body = (await response.json().catch(() => null)) as
      | { roomId?: string; token?: string; error?: string }
      | null;
    if (!response.ok || body?.roomId === undefined || body.token === undefined) {
      return body?.error ?? 'Could not create a room for that folder.';
    }

    const joinUrl = new URL(origin);
    joinUrl.searchParams.set('room', body.roomId);
    joinUrl.searchParams.set('token', body.token);
    const url = joinUrl.toString();

    // Recorded with the exact URL and a display name for the folder, not
    // just the id/token pair — `describeHostConflict` needs the name for its
    // message, and `activate` needs the URL to reopen this same room rather
    // than a fresh one (see the field's own doc comment above).
    hostedRoom = { id: body.roomId, token: body.token, folderName: folderDisplayName(localPath), url };
    if (shareMenuItem !== undefined) shareMenuItem.enabled = true;

    // Shown BEFORE the room window opens — this IS "after the room exists,
    // show the joinable URL" (CLAUDE.md), and it has to be a native dialog
    // rather than something painted into the (chrome-less, address-bar-less)
    // room window: this app never touches apps/web's own UI.
    await dialog.showMessageBox({ type: 'info', message: 'Room ready', detail: roomReadyMessage(url) });

    createWindow(url);
    getJoinWindow()?.close();
    return null;
  });
}

/**
 * "Share on Local Network" — the explicit, separate action that takes a
 * loopback-only local room wide. Guarded on actually hosting one:
 * `httpServer`/`currentPort`/`hostedRoom` are only ever set by a successful
 * `nexus:open-folder`, so a "Join a room" session (which never calls
 * `startBackend`) has nothing here to share, and the menu item stays
 * disabled the whole time rather than reaching this function at all.
 *
 * Re-listens the SAME `httpServer` on the SAME port, just on `0.0.0.0`
 * instead of `127.0.0.1` — never a fresh `createServer()` (which would mint
 * a second, contradictory server around the same in-memory room registry)
 * and never a new port (which would strand the room window already loaded
 * against the old one). `closeAllConnections()` is what makes the
 * close-then-relisten actually finish promptly: a plain `close()` only
 * refuses NEW connections and waits for existing ones to end on their own,
 * and the room window's own already-open WebSocket would otherwise hold the
 * old listener open indefinitely. The web client reconnects on its own
 * (`ws.ts`'s backoff) once the new listener comes up on the same origin.
 */
async function shareOnLan(window: BrowserWindow): Promise<void> {
  if (httpServer === undefined || currentPort === undefined || hostedRoom === undefined) return;
  const port = currentPort;
  const addresses = localNetworkAddresses();

  if (sharedOnLan) {
    await dialog.showMessageBox(window, {
      type: 'info',
      message: 'Already sharing on this network',
      detail: lanShareConfirmMessage(addresses, port),
    });
    return;
  }

  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['Cancel', 'Share'],
    defaultId: 0,
    cancelId: 0,
    message: 'Share this room on your local network?',
    detail: lanShareConfirmMessage(addresses, port),
  });
  if (response !== 1 || addresses.length === 0) return;

  const server = httpServer;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err !== undefined ? reject(err) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve());
  });
  sharedOnLan = true;

  await dialog.showMessageBox(window, {
    type: 'info',
    message: 'Sharing on your local network',
    detail: `This room is reachable from your network at:\n\n${addresses
      .map((address) => `http://${address}:${port}`)
      .join('\n')}`,
  });
}

/**
 * A minimal application menu, built once. macOS needs its own app/edit menus
 * for standard shortcuts (Cmd+Q, Cmd+C/V in the join screen's inputs) to work
 * the way a user expects — replacing the default menu entirely (rather than
 * appending to it) is only safe because the built-in `role`s below recreate
 * exactly that, plus the one item this phase adds.
 */
function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? ([{ role: 'appMenu' }] as const) : []),
    { role: 'editMenu' },
    {
      label: 'Room',
      submenu: [
        {
          id: 'share-lan',
          label: 'Share on Local Network…',
          enabled: false,
          click: () => {
            if (currentRoomWindow !== undefined) void shareOnLan(currentRoomWindow);
          },
        },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  shareMenuItem = menu.getMenuItemById('share-lan') ?? undefined;
}

async function main(): Promise<void> {
  await app.whenReady();
  buildMenu();

  /**
   * The app now OPENS ON A CHOICE rather than on a local room (phase 16a).
   *
   * Before this, `main()` started the in-process server unconditionally and
   * loaded it — which is why the desktop app could only ever be an island. It
   * now asks first, and the server starts only down the "open a folder"
   * branch (phase 17c). That is the whole shape of the fix: joining is not a
   * mode bolted onto a local server, it is the absence of one.
   */
  let joinWindow: BrowserWindow | null = createJoinWindow();
  joinWindow.on('closed', () => {
    joinWindow = null;
  });
  registerJoinHandlers(() => joinWindow);

  app.on('activate', () => {
    // macOS convention: the app stays alive after every window closes, and
    // clicking the dock icon should bring a window back.
    if (BrowserWindow.getAllWindows().length > 0) return;

    // If this process is already HOSTING a room, bring THAT back — never the
    // join chooser. This is the other half of the "second host" fix
    // (hostGuard.ts): as long as `hostedRoom` is set, there must be no
    // window anywhere from which "Open a folder" could be clicked for a
    // DIFFERENT folder, or the in-handler guard would be the only thing
    // standing between a user and a second, invisible server. Closing this
    // room's window and clicking the dock icon is precisely the scenario the
    // reviewer's finding described, and this is "how to get back to it".
    if (hostedRoom !== undefined) {
      createWindow(hostedRoom.url);
      return;
    }

    // Otherwise nothing has been chosen yet — the thing to bring back is the
    // choice.
    joinWindow = createJoinWindow();
    joinWindow.on('closed', () => {
      joinWindow = null;
    });
  });
}

app.on('window-all-closed', () => {
  // Standard Electron convention, not a SynCode-specific choice: on macOS
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
  console.error('SynCode desktop failed to start:', error);
  app.quit();
});
