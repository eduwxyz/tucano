import { contextBridge, ipcRenderer } from 'electron'

// The page asks for a port to the core; it arrives here and is handed to the
// page through window.postMessage, the only way to pass a port across
// context isolation.
ipcRenderer.on('core:port', (event) => {
  window.postMessage('core:port', '*', event.ports)
})

contextBridge.exposeInMainWorld('tucano', {
  clientPlatform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
  remoteMode: ipcRenderer.sendSync('remote:mode') as boolean,
  remote: {
    state: (): Promise<unknown> => ipcRenderer.invoke('remote:state'),
    onState: (cb: (state: unknown) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: unknown): void => cb(state)
      ipcRenderer.on('remote:state', listener)
      return () => { ipcRenderer.removeListener('remote:state', listener) }
    },
    pair: (link: string): Promise<void> => ipcRenderer.invoke('remote:pair', link),
    select: (id: string | null): Promise<void> => ipcRenderer.invoke('remote:select', id),
    rename: (id: string, name: string): Promise<void> => ipcRenderer.invoke('remote:rename', id, name),
    forget: (id: string): Promise<void> => ipcRenderer.invoke('remote:forget', id)
  },
  connect: (): void => ipcRenderer.send('core:connect'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('pick-folder') as Promise<string | null>,
  // A click on a notification opens its conversation.
  onNavigate: (cb: (conversationId: string) => void): void => {
    ipcRenderer.on('navigate', (_e, id: unknown) => typeof id === 'string' && cb(id))
  },
  // The conversation on screen: the Mac doesn't notify about the one you're reading.
  viewing: (conversationId: string | null): void => ipcRenderer.send('viewing', conversationId),
  // The app's own updates.
  updateState: (): Promise<unknown> => ipcRenderer.invoke('update:state'),
  onUpdate: (cb: (state: unknown) => void): void => {
    ipcRenderer.on('update', (_e, state: unknown) => cb(state))
  },
  checkUpdates: (): void => ipcRenderer.send('update:check'),
  installUpdate: (): void => ipcRenderer.send('update:install')
})
