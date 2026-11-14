import { contextBridge, ipcRenderer } from 'electron'

// A server's page in the app's window (src/main/servers.ts) gets only this: hand the app a
// notification to show as its own, and hear where its click goes. Nothing else of this computer.
contextBridge.exposeInMainWorld('tucanoDesktop', {
  notify: (note: unknown): void => ipcRenderer.send('server:notify', note),
  onOpen: (cb: (note: unknown) => void): void => {
    ipcRenderer.on('server:open', (_e, note: unknown) => cb(note))
  },
  // The app's own updates: with a server on screen its page is the only one there to say a new
  // version is ready. It reads the state and asks for a look; putting the version in is asked of
  // the person by the app itself (src/main/index.ts), never done on the page's word alone.
  updateState: (): Promise<unknown> => ipcRenderer.invoke('server:update-state'),
  onUpdate: (cb: (state: unknown) => void): void => {
    ipcRenderer.on('server:update', (_e, state: unknown) => cb(state))
  },
  checkUpdates: (): void => ipcRenderer.send('server:update-check'),
  installUpdate: (): void => ipcRenderer.send('server:update-install')
})
