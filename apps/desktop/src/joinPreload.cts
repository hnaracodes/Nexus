// Preload for the JOIN window only. `.cts` for the same reason as
// `preload.cts`: Electron's preload sandbox is the one place where CommonJS
// has been the reliable bet across versions.
//
// This one DOES expose capability, unlike `preload.cts`, and the difference is
// deliberate. `preload.cts` serves a window showing a ROOM — remote content, in
// the 16a case served by a machine we do not control — and exposes nothing but
// a version string. This serves `join.html`, which ships inside the app bundle
// and is the only page the user sees before any origin is trusted. Handing our
// own page one narrow channel is not the same act as handing it to a room.
//
// The channel carries a string one way and gets a verdict back. Nothing here
// touches the filesystem, spawns anything, or lets the page choose what main
// does with the string — `main.ts` parses it through `parseRoomLink` and can
// refuse.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('nexusJoin', {
  /** Hand main a pasted room link. Resolves to null on success (the window is
   *  replaced), or a human-readable problem to display. */
  submit: (link: string): Promise<string | null> => ipcRenderer.invoke('nexus:join', link),
  /**
   * Phase 17c, step 1 of "Open a folder": ask main to show the native folder
   * picker. Resolves to null if the user cancels, or to the consent text to
   * display — never to the path itself. This page never learns, and never
   * gets to name, which folder was picked; see main.ts's `pendingFolderPath`.
   */
  pickFolder: (): Promise<{ consent: string } | null> => ipcRenderer.invoke('nexus:pick-folder'),
  /**
   * Step 2: create the room from the folder already picked, using this API
   * key. Resolves to null on success (the window is replaced), or a
   * human-readable problem to display.
   */
  openFolder: (apiKey: string): Promise<string | null> => ipcRenderer.invoke('nexus:open-folder', apiKey),
});
