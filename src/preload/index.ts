import { contextBridge, ipcRenderer, webUtils } from 'electron'

// The page asks for a port to the core; it arrives here and is handed to the
// page through window.postMessage, the only way to pass a port across
// context isolation.
ipcRenderer.on('core:port', (event) => {
  window.postMessage('core:port', '*', event.ports)
})

contextBridge.exposeInMainWorld('tucano', {
  workspaces: {
    list: () => ipcRenderer.invoke('workspaces:list'),
    create: (name?: string) => ipcRenderer.invoke('workspaces:create', name),
    delete: (id?: string) => ipcRenderer.invoke('workspaces:delete', id),
    duplicate: (id: string, name?: string, parts?: object) => ipcRenderer.invoke('workspaces:duplicate', id, name, parts),
    setPaused: (paused: boolean, id?: string) => ipcRenderer.invoke('workspaces:pause', paused, id),
    switch: (id: string) => ipcRenderer.invoke('workspaces:switch', id),
    subscribe: (cb: (list: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, list: unknown): void => cb(list)
      ipcRenderer.on('workspaces', listener)
      return () => ipcRenderer.removeListener('workspaces', listener)
    }
  },
  connect: (): void => ipcRenderer.send('core:connect'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('pick-folder') as Promise<string | null>,
  // A picture right-clicked in a conversation: saved where the person says, or into the clipboard.
  image: {
    save: (url: string, title: string): Promise<{ result: 'saved'; path: string } | { result: 'cancelled' | 'failed' }> =>
      ipcRenderer.invoke('image:save', { url, title }) as Promise<{ result: 'saved'; path: string } | { result: 'cancelled' | 'failed' }>,
    copy: (url: string): Promise<boolean> => ipcRenderer.invoke('image:clipboard', { url }) as Promise<boolean>,
    read: (url: string): Promise<{ mime: string; data: string } | null> => ipcRenderer.invoke('image:read', { url }) as Promise<{ mime: string; data: string } | null>
  },
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
  // Settings › General › Notifications: one now, to see that they come.
  testNotify: (): Promise<unknown> => ipcRenderer.invoke('notify:test'),
  // The conversation on screen: the Mac doesn't notify about the one you're reading.
  viewing: (conversationId: string | null): void => ipcRenderer.send('viewing', conversationId),
  // The app's own updates.
  updateState: (): Promise<unknown> => ipcRenderer.invoke('update:state'),
  onUpdate: (cb: (state: unknown) => void): void => {
    ipcRenderer.on('update', (_e, state: unknown) => cb(state))
  },
  checkUpdates: (): void => ipcRenderer.send('update:check'),
  installUpdate: (): void => ipcRenderer.send('update:install'),
  // Seu iPhone: the app on the phone, over the home Wi-Fi (src/main/home-phone.ts).
  phone: {
    state: (): Promise<unknown> => ipcRenderer.invoke('home-phone:state'),
    set: (on: boolean): Promise<unknown> => ipcRenderer.invoke('home-phone:set', on),
    code: (): Promise<unknown> => ipcRenderer.invoke('home-phone:code'),
    onChanged: (cb: (state: unknown) => void): (() => void) => {
      const listener = (_e: unknown, state: unknown): void => cb(state)
      ipcRenderer.on('home-phone', listener)
      return () => ipcRenderer.removeListener('home-phone', listener)
    }
  },
  // Tucanos on servers, shown in this window over the app (Settings › Servers, the workspace list).
  servers: {
    list: (): Promise<unknown> => ipcRenderer.invoke('servers:list'),
    pair: (link: string): Promise<unknown> => ipcRenderer.invoke('servers:pair', link),
    open: (id: string): void => ipcRenderer.send('servers:open', id),
    local: (): void => ipcRenderer.send('servers:local'),
    forget: (id: string): Promise<unknown> => ipcRenderer.invoke('servers:forget', id),
    // Returns how to stop listening: each screen showing the list listens while it's open.
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('servers', listener)
      return () => ipcRenderer.removeListener('servers', listener)
    }
  }
})
