// The people of a Tucano as the server meets them: a browser signs in with the owner's token
// or a person's key (the core says whose), each event stream is someone's, and a notification
// reaches only the streams of the people it's for. Someone new comes in through an invite's page.
import type { Person } from '../shared/types'

// A key's answer from the core is trusted this long: a removal drops it at once anyway.
export const AUTH_CACHE_MS = 30_000

export class Signins {
  private cache = new Map<string, { person: Person; at: number }>()

  constructor(
    private ask: (key: string) => Promise<Person | { removed: true } | undefined>,
    private now: () => number = Date.now
  ) {}

  // The person a key opens, asking the core when it isn't remembered. A refused key isn't kept:
  // each try costs the asker a guess instead (unless it was someone's who was removed).
  async lookup(key: string): Promise<{ person?: Person; removed?: boolean } | undefined> {
    const hit = this.cache.get(key)
    if (hit && this.now() - hit.at < AUTH_CACHE_MS) return { person: hit.person }
    this.cache.delete(key)
    const found = await this.ask(key)
    if (found && 'removed' in found) return { removed: true }
    if (found) this.cache.set(key, { person: found, at: this.now() })
    if (this.cache.size > 1_000) this.cache.delete(this.cache.keys().next().value!)
    return found ? { person: found } : undefined
  }

  async person(key: string): Promise<Person | undefined> {
    return (await this.lookup(key))?.person
  }

  // Removed: their keys open nothing from now on.
  forget(personId: string): void {
    for (const [key, hit] of this.cache) if (hit.person.id === personId) this.cache.delete(key)
  }
}

// Whether someone may see a file or page that came from a conversation (an artifact, an agent's
// page): the core says, and the answer is kept a few seconds (pages ask for many images at once).
export class Grants {
  private cache = new Map<string, { ok: boolean; at: number }>()

  constructor(
    private ask: (person: string, what: { artifact: string } | { port: number }) => Promise<boolean | undefined>,
    private now: () => number = Date.now
  ) {}

  async may(person: string | undefined, what: { artifact: string } | { port: number }): Promise<boolean> {
    if (!person) return false
    const key = `${person}\n${'artifact' in what ? `a:${what.artifact}` : `p:${what.port}`}`
    const hit = this.cache.get(key)
    if (hit && this.now() - hit.at < AUTH_CACHE_MS) return hit.ok
    const ok = (await this.ask(person, what)) === true
    this.cache.set(key, { ok, at: this.now() })
    if (this.cache.size > 5_000) this.cache.delete(this.cache.keys().next().value!)
    return ok
  }

  forget(personId: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(`${personId}\n`)) this.cache.delete(key)
  }
}

// Who a request is: the owner (by the server's token) or a person (by their key).
export type Who = { owner: true; person?: undefined; role: 'owner' } | { owner?: undefined; person: string; role: Person['role'] }

export interface Stream {
  who: Who
  send(msg: unknown): void
  end(): void
}

// The open event streams, each one someone's.
export class Streams<S extends Stream = Stream> {
  private all = new Map<string, S>()

  add(id: string, s: S): void {
    this.all.set(id, s)
  }

  get(id: string): S | undefined {
    return this.all.get(id)
  }

  delete(id: string): void {
    this.all.delete(id)
  }

  // `to`: the people it's for, by id; unset, everyone. An owner-token stream is the owner's.
  deliver(msg: unknown, to: string[] | undefined, ownerId: string | undefined): void {
    for (const s of this.all.values()) {
      const id = s.who.owner ? ownerId : s.who.person
      if (!to || (id !== undefined && to.includes(id))) s.send(msg)
    }
  }

  // A removed person's streams end now.
  endFor(personId: string): void {
    for (const [id, s] of [...this.all]) {
      if (s.who.person !== personId) continue
      this.all.delete(id)
      s.end()
    }
  }
}

// The conversation each page has open, so the core reads what arrives there as read for its person
// (as the desktop's window does). The core keeps one per person: their latest page's, and when that
// page closes, the one they looked at last of those still open. `person`: '' is the owner's token.
export class Viewers {
  private pages = new Map<string, { person: string; conversation: string | null; at: number }>()
  private tick = 0

  // What the person is looking at now.
  set(stream: string, person: string, conversation: string | null): string | null {
    this.pages.set(stream, { person, conversation, at: ++this.tick })
    return conversation
  }

  // A page closed: what its person is looking at now, if it was one that said.
  drop(stream: string): { person: string; conversation: string | null } | undefined {
    const gone = this.pages.get(stream)
    if (!gone) return undefined
    this.pages.delete(stream)
    const latest = [...this.pages.values()].filter((p) => p.person === gone.person).sort((a, b) => b.at - a.at)[0]
    return { person: gone.person, conversation: latest?.conversation ?? null }
  }

  // A removed person's pages are gone at once.
  forget(person: string): void {
    for (const [id, p] of this.pages) if (p.person === person) this.pages.delete(id)
  }
}

// What the core tells the server about a person. Removed: their sign-ins are forgotten and their
// open pages lose the line at once. Their role changed: what was remembered of them (their role,
// what they may open) is asked again on the next request; their pages stay. True when handled.
export function personNotice(
  msg: { type: string; id?: string },
  parts: { signins: Pick<Signins, 'forget'>; grants: Pick<Grants, 'forget'>; viewers: Pick<Viewers, 'forget'>; streams: Pick<Streams, 'endFor'> }
): boolean {
  if ((msg.type !== 'person-removed' && msg.type !== 'person-changed') || !msg.id) return false
  parts.signins.forget(msg.id)
  parts.grants.forget(msg.id)
  if (msg.type === 'person-removed') {
    parts.viewers.forget(msg.id)
    parts.streams.endFor(msg.id)
  }
  return true
}

const esc = (t: string): string => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// The plain page every server-made page shares (the OAuth callback's look).
export const PAGE_STYLE =
  'body{font:15px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f3ee;color:#1d1a16}@media(prefers-color-scheme:dark){body{background:#1a1917;color:#f1ece4}input{background:#262421;color:inherit}}main{max-width:460px;padding:24px}p{opacity:.8;line-height:1.5}form{display:grid;gap:10px;margin-top:16px}input{font:inherit;padding:10px 12px;border:1px solid #8884;border-radius:8px}button{font:inherit;padding:10px 12px;border:0;border-radius:8px;background:#1d1a16;color:#f6f3ee;cursor:pointer}.err{color:#b3261e;opacity:1}'
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"

// "Você foi convidado pro Tucano de <name>": a name, and in. The code goes back in a hidden field;
// whether it's still good is only known on Entrar (no page tells a guesser which codes exist).
export function invitePage(o: { owner: string; code: string; name?: string; error?: string }): string {
  const whose = o.owner.trim()
  const title = whose ? `Você foi convidado pro Tucano de ${whose} · You were invited to ${whose}'s Tucano` : 'Você foi convidado pro Tucano · You were invited to a Tucano'
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tucano</title><style>${PAGE_STYLE}</style><main><h2>${esc(title)}</h2><p>Diga seu nome: é como as pessoas e os agentes vão te chamar. · Tell us your name: it's what people and agents will call you.</p>${o.error ? `<p class="err">${esc(o.error)}</p>` : ''}<form method="post" action="./join"><input type="hidden" name="code" value="${esc(o.code)}"><input name="name" autocomplete="name" maxlength="60" required autofocus placeholder="Seu nome · Your name" value="${esc(o.name ?? '')}"><button type="submit">Entrar · Join</button></form></main>`
}

// The join form's fields, from the page's form or a program's JSON.
export function joinFields(body: string, contentType: string | undefined): { code: string; name: string } {
  let code: unknown
  let name: unknown
  if ((contentType ?? '').includes('application/json')) {
    try {
      ;({ code, name } = JSON.parse(body) as { code?: unknown; name?: unknown })
    } catch {}
  } else {
    const f = new URLSearchParams(body)
    code = f.get('code')
    name = f.get('name')
  }
  return { code: typeof code === 'string' ? code.slice(0, 200) : '', name: typeof name === 'string' ? name.slice(0, 200) : '' }
}

// What a removed person's browser reads, instead of everything: nothing about the Tucano itself.
export const NO_ACCESS_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tucano</title><style>${PAGE_STYLE}</style><main><h2>Você não tem mais acesso a este Tucano. · You no longer have access to this Tucano.</h2><p>Se foi engano, peça um novo convite a quem cuida dele. · If that's a mistake, ask whoever runs it for a new invite.</p></main>`

// What a browser that isn't signed in reads.
export const UNAUTHORIZED_TEXT =
  'Tucano: open the link from `node out/main/server.js link`, or the invite link someone sent you.\nTucano: abra o link que o `node out/main/server.js link` mostra, ou o link de convite que te mandaram.'
