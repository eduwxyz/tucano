import { contextBridge, ipcRenderer } from 'electron'

// A server's page in the app's window (src/main/servers.ts) gets only this: hand the app a
// notification to show as its own, and hear where its click goes. Nothing else of this computer.
contextBridge.exposeInMainWorld('tucanoDesktop', {
  notify: (note: unknown): void => ipcRenderer.send('server:notify', note),
  onOpen: (cb: (note: unknown) => void): void => {
    ipcRenderer.on('server:open', (_e, note: unknown) => cb(note))
  }
})
