import { contextBridge, ipcRenderer, webUtils } from 'electron'

// The page asks for a port to the core; it arrives here and is handed to the
// page through window.postMessage, the only way to pass a port across
// context isolation.
ipcRenderer.on('core:port', (event) => {
  window.postMessage('core:port', '*', event.ports)
})

contextBridge.exposeInMainWorld('tucano', {
  connect: (): void => ipcRenderer.send('core:connect'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('pick-folder') as Promise<string | null>,
  // A picked file's path, so the core reads a big .zip in parts instead of through the page.
  pathOf: (file: File): string => webUtils.getPathForFile(file),
  // A click on a notification opens its conversation, and the thread it's about.
  onNavigate: (cb: (conversationId: string, threadId?: string) => void): void => {
    ipcRenderer.on('navigate', (_e, id: unknown, thread: unknown) => typeof id === 'string' && cb(id, typeof thread === 'string' ? thread : undefined))
  },
  // …or a screen (a skill proposal opens Skills).
  onNavigatePage: (cb: (page: 'skills') => void): void => {
    ipcRenderer.on('navigate-page', (_e, page: unknown) => page === 'skills' && cb(page))
  },
  // The core's process ended: the page says so and offers to reload, which starts a new one.
  onCoreDown: (cb: () => void): void => {
    ipcRenderer.on('core:down', () => cb())
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
