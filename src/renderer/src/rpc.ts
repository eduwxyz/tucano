import { L } from '../../shared/lang'
import type { CoreEvent, Method, Params, Request, Result, Wire } from '../../shared/rpc'
import type { UpdateState } from '../../shared/types'

declare global {
  interface Window {
    tucano: {
      connect: () => void
      pickFolder: () => Promise<string | null>
      pathOf?: (file: File) => string // a dropped or picked file's path on this computer (desktop only)
      onNavigate: (cb: (conversationId: string, threadId?: string) => void) => void
      onNavigatePage?: (cb: (page: 'skills') => void) => void // desktop only
      onCoreDown?: (cb: () => void) => void // desktop only: a browser reloads on its own
      viewing: (conversationId: string | null) => void
      updateState: () => Promise<UpdateState>
      onUpdate: (cb: (state: UpdateState) => void) => void
      checkUpdates: () => void
      installUpdate: () => void
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
