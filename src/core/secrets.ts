// Connector credentials (tokens, OAuth state, env values) are encrypted with
// the OS keychain before they reach SQLite. Only the main process can use
// Electron's safeStorage, so the core asks it over the parent port.
import { randomUUID } from 'node:crypto'
import type { Db } from './db'

export interface Cipher {
  encrypt(plain: string): Promise<string>
  decrypt(sealed: string): Promise<string>
}

// For tests and the fake mode: marks values as unencrypted instead of pretending.
export const plainCipher: Cipher = {
  encrypt: async (s) => `plain:${s}`,
  decrypt: async (s) => s.replace(/^plain:/, '')
}

type Reply = { type: 'secret-result'; id: string; data?: string; error?: string }

export function mainCipher(port: Electron.ParentPort): Cipher {
  const pending = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>()
  port.on('message', (e) => {
    const r = e.data as Reply | undefined
    if (r?.type !== 'secret-result') return
    const p = pending.get(r.id)
    if (!p) return
    pending.delete(r.id)
    if (r.error !== undefined) p.reject(new Error(r.error))
    else p.resolve(r.data ?? '')
  })
  const ask = (op: 'encrypt' | 'decrypt', data: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const id = randomUUID()
      pending.set(id, { resolve, reject })
      port.postMessage({ type: 'secret', id, op, data })
    })
  return { encrypt: (s) => ask('encrypt', s), decrypt: (s) => ask('decrypt', s) }
}

// A saved value that's there but can't be opened: the system's key changed or wasn't given (the Keychain
// said no). It stays as it was, encrypted: a later launch with the key back opens it again.
export class UnreadableSecret extends Error {
  constructor(
    readonly key: string,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'UnreadableSecret'
  }
}

export const unreadable = (e: unknown): UnreadableSecret | undefined => {
  for (let x = e, i = 0; x && i < 5; x = (x as { cause?: unknown }).cause, i++) if (x instanceof UnreadableSecret) return x
  return undefined
}

export class Secrets {
  constructor(
    private db: Db,
    private cipher: Cipher
  ) {}

  async get(key: string): Promise<string | undefined> {
    const sealed = this.db.getSecret(key)
    if (sealed === undefined) return undefined
    try {
      return await this.cipher.decrypt(sealed)
    } catch (e) {
      console.error(`[secrets] couldn't open ${key}; it stays saved`) // the key only: never the value
      throw new UnreadableSecret(key, e)
    }
  }

  async getJson<T>(key: string): Promise<T | undefined> {
    const v = await this.get(key)
    return v === undefined ? undefined : (JSON.parse(v) as T)
  }

  async set(key: string, value: string | undefined): Promise<void> {
    this.db.setSecret(key, value === undefined ? undefined : await this.cipher.encrypt(value))
  }

  setJson(key: string, value: unknown): Promise<void> {
    return this.set(key, value === undefined ? undefined : JSON.stringify(value))
  }
}
