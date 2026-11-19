// Notifications to the Tucano app on a closed iPhone, through the push relay at tucano.sh
// (site/push.js): each phone gave this Tucano a handle (its Apple token, sealed by the relay), kept
// on its device key, so it goes when the device is disconnected. What a phone gets is what the
// desktop's notification says: a title and a line. TUCANO_PUSH_URL points at another relay, or
// `off` turns it off.
export interface PushTarget {
  hash: string // the device key's
  handle: string
  tag?: string // the app's name for this Tucano, so a tap opens the right one
}

export interface PushNote {
  title: string
  body: string
  conversationId?: string
  threadId?: string
  kind?: string
}

export const PUSH_URL = 'https://tucano.sh/api/push'

export class Push {
  constructor(
    private deps: {
      url: string | undefined // the relay; undefined: off
      targets: (to: string[] | undefined) => PushTarget[] // the phones of these people (unset: everyone's)
      gone: (hash: string) => void // Apple no longer knows that phone: forget its handle
      fetch?: typeof fetch
    }
  ) {}

  get on(): boolean {
    return !!this.deps.url
  }

  // Fire and forget: a relay that's down only means no push this time.
  send(note: PushNote, to: string[] | undefined): Promise<void> {
    const url = this.deps.url
    if (!url) return Promise.resolve()
    const all = this.deps.targets(to)
    if (!all.length) return Promise.resolve()
    const chunks: PushTarget[][] = []
    for (let i = 0; i < all.length; i += 20) chunks.push(all.slice(i, i + 20))
    return Promise.all(
      chunks.map(async (chunk) => {
        try {
          const r = await (this.deps.fetch ?? fetch)(`${url}/send`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...note, targets: chunk.map((t) => ({ handle: t.handle, ...(t.tag ? { tag: t.tag } : {}) })) }),
            signal: AbortSignal.timeout(15_000)
          })
          if (!r.ok) return console.error('[push]', r.status)
          const { gone } = (await r.json()) as { gone?: unknown }
          if (Array.isArray(gone)) for (const t of chunk) if (gone.includes(t.handle)) this.deps.gone(t.hash)
        } catch (e) {
          console.error('[push]', e instanceof Error ? e.message : e)
        }
      })
    ).then(() => undefined)
  }
}

// The relay from the environment: the default, another one, or none.
export function pushUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env['TUCANO_PUSH_URL']?.trim()
  if (v === 'off' || v === '0') return undefined
  return (v || PUSH_URL).replace(/\/+$/, '')
}
