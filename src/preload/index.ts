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
  // The cards over every window (src/main/notice.ts): what arrives, what to do with it, and where
  // the pointer is, so the window can let the click through everywhere there's no card.
  notice: {
    onPush: (cb: (p: unknown) => void): void => {
      ipcRenderer.on('notice:push', (_e, p: unknown) => cb(p))
    },
    onClear: (cb: () => void): void => {
      ipcRenderer.on('notice:clear', () => cb())
    },
    // The rectangle the cards sit in, and which way they grow: main owns the window, the page draws.
    onPlace: (cb: (p: { up: boolean; dark: boolean; accent: string }) => void): void => {
      ipcRenderer.on('notice:place', (_e, p: { up: boolean; dark: boolean; accent: string }) => cb(p))
    },
    // The rectangle, drawn on screen (Settings › Notifications › Where).
    pick: (): void => ipcRenderer.send('notice:pick'),
    demo: (): void => ipcRenderer.send('notice:demo'),
    onDemo: (cb: () => void): void => {
      ipcRenderer.on('notice:demo', () => cb())
    },
    onPick: (cb: (rect: { x: number; y: number; w: number; h: number; up: boolean }) => void): void => {
      ipcRenderer.on('notice:pick', (_e, rect: { x: number; y: number; w: number; h: number; up: boolean }) => cb(rect))
    },
    areaDone: (): void => ipcRenderer.send('notice:area-done'),
    areaCancel: (): void => ipcRenderer.send('notice:area-cancel'),
    hit: (inside: boolean): void => ipcRenderer.send('notice:hit', inside),
    count: (n: number): void => ipcRenderer.send('notice:count', n),
    open: (p: { conversationId?: string; threadId?: string; page?: 'skills' }): void => ipcRenderer.send('notice:open', p)
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
