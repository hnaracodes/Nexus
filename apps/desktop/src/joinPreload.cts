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
  /** Start the in-process server and open a local room, today's behaviour. */
  workLocally: (): Promise<void> => ipcRenderer.invoke('nexus:work-locally'),
});
