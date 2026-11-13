import { L } from '../../shared/lang'
import type { CoreEvent, Method, Params, Request, Result, Wire } from '../../shared/rpc'
import type { UpdateState } from '../../shared/types'
import type { WorkspaceList, WorkspaceParts } from '../../shared/workspaces'

// Seu iPhone: on, where the phone finds this computer, and how many are on the line now.
export type NotifyState = 'on' | 'ask' | 'blocked' | 'insecure' | 'unsupported'

export type PhoneState = { on: boolean; address: string; connected: number; workspace: string; error?: string }

declare global {
  interface Window {
    tucano: {
      workspaces?: {
        list: () => Promise<WorkspaceList>
        create: (name?: string) => Promise<void>
        delete: (id?: string) => Promise<void>
        duplicate: (id: string, name?: string, parts?: WorkspaceParts) => Promise<string>
        setPaused: (paused: boolean, id?: string) => Promise<void>
        switch: (id: string) => Promise<void>
        subscribe: (cb: (list: WorkspaceList) => void) => () => void
      }
      connect: () => void
      pickFolder: () => Promise<string | null>
      pathOf?: (file: File) => string // a dropped or picked file's path on this computer (desktop only)
      upload?: (file: File, purpose?: 'message') => Promise<string> // a file sent to the server, and where it landed there (server only)
      onNavigate: (cb: (conversationId: string, threadId?: string) => void) => void
      onNavigatePage?: (cb: (page: 'skills') => void) => void // desktop only
      onCoreDown?: (cb: () => void) => void // desktop only: a browser reloads on its own
      viewing: (conversationId: string | null) => void
      // Settings › General › Notifications: one sent now ('shown'), or why none can come here
      // (a browser: blocked by the person, or a page without HTTPS, where browsers show none).
      testNotify?: () => Promise<NotifyState | 'shown'>
      // The cards over every window (src/main/notice.ts): what the main process sends, where the
      // pointer is, how many cards there are, and a click that opens the app.
      notice: {
        onPush: (cb: (p: unknown) => void) => void
        onClear: (cb: () => void) => void
        onPlace: (cb: (p: { up: boolean; dark: boolean; accent: string }) => void) => void
        pick: () => void
        demo: () => void
        onDemo: (cb: () => void) => void
        onPick: (cb: (rect: { x: number; y: number; w: number; h: number; up: boolean }) => void) => void
        areaDone: () => void
        areaCancel: () => void
        hit: (inside: boolean) => void
        count: (n: number) => void
        open: (to: { conversationId?: string; threadId?: string; page?: 'skills' }) => void
      }
      notifyState?: () => NotifyState // a browser only: where its notifications stand now
      updateState: () => Promise<UpdateState>
      onUpdate: (cb: (state: UpdateState) => void) => void
      checkUpdates: () => void
      installUpdate: () => void
      phone?: {
        // desktop only: the iPhone app over the home Wi-Fi (src/main/home-phone.ts)
        state: () => Promise<PhoneState | undefined>
        set: (on: boolean) => Promise<PhoneState | undefined>
        code: () => Promise<{ link: string; expiresAt: number } | undefined>
        onChanged: (cb: (state: PhoneState) => void) => () => void
      }
      servers?: {
        // desktop only: Tucanos on servers, shown in this window over the app; open: the one on screen
        list: () => Promise<{ id: string; name: string; origin: string; open: boolean }[]>
        pair: (link: string) => Promise<'paired' | 'cancelled' | 'invalid' | 'unsafe' | 'used' | 'unreachable'>
        open: (id: string) => void
        local: () => void // back to this computer's Tucano
        forget: (id: string) => Promise<boolean>
        onChanged: (cb: () => void) => () => void // returns the unsubscribe
      }
    }
  }
}

let port: MessagePort | null = null
let seq = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

// Resolves once the core's port arrives. Events flow to onEvent from then on.
export function connect(onEvent: (e: CoreEvent) => void): Promise<void> {
  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== window || e.data !== 'core:port' || !e.ports[0]) return
      window.removeEventListener('message', onMessage)
      port = e.ports[0]
      port.onmessage = (m: MessageEvent<Wire>) => {
        const data = m.data
        if ('event' in data) return onEvent(data.event)
        const p = pending.get(data.id)
        if (!p) return
        pending.delete(data.id)
        if (data.error !== undefined) p.reject(new Error(data.error))
        else p.resolve(data.result)
      }
      resolve()
    }
    window.addEventListener('message', onMessage)
    window.tucano.connect()
  })
}

// The core's process ended: nothing in flight will be answered, and nothing new goes out.
let down = false
const downError = (): Error => new Error(L('O Tucano parou de funcionar. Reabra pra continuar.', 'Tucano stopped working. Reopen it to go on.'))
export function disconnect(): void {
  down = true
  port = null
  for (const p of pending.values()) p.reject(downError())
  pending.clear()
}

export function call<M extends Method>(method: M, ...params: Params<M> extends undefined ? [] : [Params<M>]): Promise<Result<M>> {
  if (!port) return Promise.reject(down ? downError() : new Error(L('O Tucano ainda está abrindo. Tente de novo em instantes.', 'Tucano is still starting. Try again in a moment.')))
  const id = ++seq
  const req: Request = { id, method, params: params[0] }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    port!.postMessage(req)
  })
}
