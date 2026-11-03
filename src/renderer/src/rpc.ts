import type { CoreEvent, Method, Params, Request, Result, Wire } from '../../shared/rpc'
import type { UpdateState } from '../../shared/types'
import type { Reach } from '../../shared/pairlink'

export type RemoteState = {
  active: string | null
  profiles: { id: string; name: string; reach: Reach; remotePort: number }[]
  status: 'local' | 'connecting' | 'connected' | 'error'
  error?: string
  pairLink?: string
}

export type RemoteApi = {
  state: () => Promise<RemoteState>
  onState: (cb: (state: RemoteState) => void) => () => void
  pair: (link: string) => Promise<void>
  select: (id: string | null) => Promise<void>
  forget: (id: string) => Promise<void>
  rename?: (id: string, name: string) => Promise<void>
}

declare global {
  interface Window {
    tucano: {
      remote?: RemoteApi
      remoteMode?: boolean
      servicePreviews?: boolean
      clientPlatform?: 'mac' | 'windows' | 'linux'
      connect: () => void
      pickFolder: () => Promise<string | null>
      onNavigate: (cb: (conversationId: string) => void) => void
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

export function call<M extends Method>(method: M, ...params: Params<M> extends undefined ? [] : [Params<M>]): Promise<Result<M>> {
  if (!port) return Promise.reject(new Error('core not connected'))
  const id = ++seq
  const req: Request = { id, method, params: params[0] }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    port!.postMessage(req)
  })
}
