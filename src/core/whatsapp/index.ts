// WhatsApp for agents: the numbers the team owns, which agent may read or answer which
// conversation, and the limits that keep a number from being blocked. A number is linked by QR
// code (qr.ts, unofficial, contacts and groups) or through Meta's official API (cloud.ts, contacts
// only, needs a server Meta can call). This class is what the rest of the app talks to. Its rule
// is that nothing a person types, an agent asks or WhatsApp and Meta send ever becomes a crash:
// bad input is a UserError with a sentence, and what arrives from outside is wrapped and logged.
import { randomBytes, randomUUID } from 'node:crypto'
import { L } from '../../shared/lang'
import { UserError } from '../../shared/errors'
import {
  ALL_CHATS,
  clampSettings,
  cleanAccess,
  dayStart,
  defaultSettings,
  DESCRIPTION_MAX,
  NAME_MAX,
  phoneDigits,
  type WhatsAppAccess,
  type WhatsAppChat,
  type WhatsAppNumber,
  type WhatsAppNumberInput,
  type WhatsAppSettings,
  type WhatsAppState,
  type WhatsAppTemplate
} from '../../shared/whatsapp'
import type { Cipher } from '../secrets'
import type { ToolDef } from '../gateway'
import * as cloud from './cloud'
import { QrDriver, type QrStatus } from './qr'
import { WhatsAppStore, type NumberRow } from './store'
import { AgentTools, generic, type Runtime, type ToolCtx, type ToolOutcome } from './agent'
import { fold, tools as toolDefs } from './tools'
import { Arrivals, type Inbound } from './inbound'
import { WhatsAppMedia } from './media'

export { WHATSAPP_TOOL_NAMES, lineOf } from './tools'
export { shortId } from './store'
export type { ToolOutcome, ToolCtx } from './agent'
export type { Inbound } from './inbound'

export const WHATSAPP = 'whatsapp' // the "connector" of its send approvals

const CHANGED_EVERY_MS = 300

export interface WhatsAppDeps {
  dir: string // the data folder
  cipher: Cipher
  agents(): { id: string; name: string; archived?: boolean }[]
  changed(): void // a number's state changed: the screen reads again
  wake(agentId: string, inbound: Inbound): void
  artifact(id: string): { path: string; name: string } | undefined // a file of a conversation: where it is on disk
  transcribe?: (wav: Buffer) => Promise<string | undefined> // the words of a 16 kHz WAV; undefined: dictation isn't set up
  publicUrl?: string // a server on https only: what makes the official API possible
  log?(text: string): void
  callPermission?(numberId: string, chat: string, reply: { accepted: boolean; until?: number }): void // a person's answer to "may we call you"
  numberGone?(id: string): Promise<void> | void // a number is about to be removed: its calls are turned off first
  dial?(agentId: string, args: Record<string, unknown>, dry?: boolean): Promise<{ ok: boolean; text: string }> // an approved whatsapp_ligar; `dry` only checks
}

const gone = (): UserError => new UserError(L('Esse número de WhatsApp não existe mais.', 'That WhatsApp number no longer exists.'))

// A field the screen sends, checked: text, trimmed, within its size.
function field(v: unknown, label: string, max: number, required: boolean): string {
  if (v !== undefined && typeof v !== 'string') throw new UserError(L(`${label} precisa ser um texto.`, `${label} must be text.`))
  const t = (v ?? '').trim()
  if (required && !t) throw new UserError(L(`Escreva ${label.toLowerCase()}.`, `Write ${label.toLowerCase()}.`))
  if (t.length > max) throw new UserError(L(`${label} passa de ${max} caracteres. Encurte um pouco.`, `${label} is over ${max} characters. Shorten it a little.`))
  return t
}

export class WhatsApp {
  private db?: WhatsAppStore
  private runtimes = new Map<string, Runtime>()
  private keys = new Map<string, cloud.CloudCreds>() // official-API numbers: their opened keys
  private removing = new Set<string>() // numbers being removed: nothing may link them again meanwhile
  private token?: Promise<string>
  private notify?: NodeJS.Timeout
  private closed = false
  private media: WhatsAppMedia // the files of messages
  private arrivals: Arrivals // what comes in: stored, filed, and turned into wakes
  private agent: AgentTools

  constructor(private deps: WhatsAppDeps) {
    this.media = new WhatsAppMedia(deps.dir)
    const transcribe = deps.transcribe
    this.arrivals = new Arrivals({
      store: () => this.store,
      rt: (id) => this.rt(id),
      live: (id) => this.runtimes.has(id),
      agents: () => this.deps.agents(),
      media: this.media,
      ...(transcribe ? { transcribe } : {}),
      withPause: (id, c) => this.withPause(id, c),
      wake: (agentId, inbound) => this.deps.wake(agentId, inbound),
      changed: () => this.changed(),
      fail: (e) => this.fail(e)
    })
    this.agent = new AgentTools({
      store: () => this.store,
      rt: (id) => this.rt(id),
      keys: this.keys,
      cloudOk: () => this.cloudOk,
      view: (n, since) => this.view(n, since),
      stub: (id) => this.stub(id),
      changed: () => this.changed(),
      fail: (e) => this.fail(e),
      media: this.media,
      artifact: (id) => this.deps.artifact(id),
      speech: (data) => this.arrivals.speech(data),
      dial: (agentId, args, dry) => (this.deps.dial ? this.deps.dial(agentId, args, dry) : Promise.resolve({ ok: false, text: generic() }))
    })
  }

  // What the calls service uses of the numbers: the same store and opened keys; settings go through the usual clamp.
  forCalls() {
    return { store: this.store, cloud: (id: string) => this.keys.get(id), number: (id: string) => this.store.number(id), numbers: () => this.store.numbers(), saveCallSettings: (id: string, s: NonNullable<WhatsAppSettings['calls']>) => { const n = this.store.number(id); if (!n) throw gone(); this.store.updateNumber(id, { settings: clampSettings(n.kind, { ...n.settings, calls: s }) }); this.changed() } }
  }

  private get store(): WhatsAppStore {
    if (this.closed) throw new UserError(L('O WhatsApp está desligado agora.', 'WhatsApp is off right now.'))
    return (this.db ??= new WhatsAppStore(this.deps.dir, this.deps.cipher))
  }

  private rt(id: string): Runtime {
    let r = this.runtimes.get(id)
    if (!r) {
      r = { view: { status: 'disconnected' }, paused: new Map(), tail: Promise.resolve() }
      this.runtimes.set(id, r)
    }
    return r
  }

  private fail(e: unknown): void {
    console.error('[whatsapp]', e instanceof Error ? e.message : e)
  }

  // The screen reads again, at most once every 300 ms however many things changed.
  private changed(): void {
    if (this.notify || this.closed) return
    this.notify = setTimeout(() => {
      this.notify = undefined
      try {
        this.deps.changed()
      } catch (e) {
        this.fail(e)
      }
    }, CHANGED_EVERY_MS)
    this.notify.unref()
  }

  private get cloudOk(): boolean {
    return !!this.deps.publicUrl?.startsWith('https://')
  }

  private need(id: unknown): NumberRow {
    const n = typeof id === 'string' && !this.removing.has(id) ? this.store.number(id) : undefined
    if (!n) throw gone()
    return n
  }

  // ---------- life ----------

  // Links again every number that was linked before.
  async start(): Promise<void> {
    this.closed = false
    let rows: NumberRow[] = []
    try {
      rows = this.store.numbers()
    } catch (e) {
      this.fail(e)
      return
    }
    // The files of what the 90-day clean-up dropped when the data opened.
    void this.media.remove(this.store.takeExpired()).catch((e: unknown) => this.fail(e))
    for (const n of rows) {
      try {
        if (n.kind === 'cloud') await this.openKeys(n.id)
        else if (this.store.hasAuth(n.id, 'creds')) await this.link(n.id, undefined, true)
      } catch (e) {
        this.fail(e) // one number that won't open must not keep the others from starting
      }
    }
  }

  stop(): void {
    this.closed = true
    if (this.notify) clearTimeout(this.notify)
    this.notify = undefined
    this.arrivals.clear()
    for (const r of this.runtimes.values()) r.driver?.stop()
    this.runtimes.clear()
    this.db?.close()
    this.db = undefined
  }

  private async openKeys(id: string): Promise<cloud.CloudCreds | undefined> {
    try {
      const raw = await this.store.authGet(id, 'cloud')
      const c = raw ? (JSON.parse(raw) as Partial<cloud.CloudCreds>) : undefined
      if (!c?.phoneId || !c.wabaId || !c.token || !c.appSecret) return undefined
      const keys = { phoneId: c.phoneId, wabaId: c.wabaId, token: c.token, appSecret: c.appSecret }
      this.keys.set(id, keys)
      return keys
    } catch (e) {
      this.fail(e) // keys that cannot be opened become a sentence on the screen, not a crash
      return undefined
    }
  }

  private async link(id: string, phone?: string, onlyLinked = false): Promise<void> {
    const r = this.rt(id)
    r.driver?.stop()
    r.view = { status: 'connecting' }
    const driver: QrDriver = new QrDriver(id, this.store, {
      status: (s) => this.onStatus(id, driver, s),
      chat: (c) => {
        if (this.runtimes.has(id)) this.store.upsertChat(id, c)
      },
      message: (m) => this.arrivals.message(id, m),
      change: (c) => this.arrivals.change(id, c)
    })
    r.driver = driver
    this.changed()
    await driver.start(phone, onlyLinked)
  }

  private onStatus(id: string, driver: QrDriver, s: QrStatus): void {
    const r = this.runtimes.get(id)
    if (!r || r.driver !== driver) return
    try {
      r.view = s
      if (s.phone) this.store.updateNumber(id, { phone: s.phone })
      if (s.status === 'disconnected' && s.error) this.deps.log?.(L(`WhatsApp: um número desconectou. ${s.error}`, `WhatsApp: a number disconnected. ${s.error}`))
    } catch (e) {
      this.fail(e)
    }
    this.changed()
  }

  // ---------- what the screen reads ----------

  private view(n: NumberRow, since: number): WhatsAppNumber {
    const access = this.store.access(n.id)
    const named = new Set(access.map((a) => a.chat).filter((c) => c !== ALL_CHATS))
    const chats = [...named].map((id) => this.withPause(n.id, this.store.chat(n.id, id) ?? this.stub(id)))
    const r = this.rt(n.id)
    let status = r.view.status
    let error = r.view.error
    if (n.kind === 'cloud') {
      const ok = this.cloudOk && this.keys.has(n.id)
      status = ok ? 'connected' : 'disconnected'
      error = !this.cloudOk ? this.cloudWhy() : !this.keys.has(n.id) ? L('Não consegui abrir as chaves deste número. Remova-o e adicione de novo.', "I couldn't open this number's keys. Remove it and add it again.") : r.error
    }
    const phone = r.view.phone ?? n.phone
    return {
      id: n.id,
      name: n.name,
      description: n.description,
      kind: n.kind,
      ...(phone ? { phone } : {}),
      status,
      ...(error ? { error } : {}),
      ...(n.kind === 'qr' && r.view.qr ? { qr: r.view.qr } : {}),
      ...(n.kind === 'qr' && r.view.pairingCode ? { pairingCode: r.view.pairingCode } : {}),
      settings: n.settings,
      access,
      chats,
      sentToday: this.store.sentToday(n.id, since),
      newToday: this.store.newToday(n.id, since),
      createdAt: n.createdAt
    }
  }

  private stub(id: string): WhatsAppChat {
    return { id, name: id.split('@')[0] || id, kind: id.endsWith('@g.us') ? 'group' : 'contact' }
  }

  private withPause(numberId: string, c: WhatsAppChat): WhatsAppChat {
    const until = this.runtimes.get(numberId)?.paused.get(c.id)
    return until && until > Date.now() ? { ...c, pausedUntil: until } : c
  }

  private cloudWhy(): string {
    return L('A API oficial da Meta precisa que o Tucano rode num servidor com endereço https, para a Meta conseguir avisar quando chega uma mensagem.', "Meta's official API needs Tucano to run on a server with an https address, so Meta can tell it when a message arrives.")
  }

  private verifyToken(): Promise<string> {
    this.token ??= (async () => {
      const have = await this.store.authGet('', 'verify_token')
      if (have) return have
      const fresh = randomBytes(24).toString('base64url')
      await this.store.authSet('', [['verify_token', fresh]])
      return fresh
    })().catch((e: unknown) => {
      this.token = undefined
      throw e
    })
    return this.token
  }

  async state(): Promise<WhatsAppState> {
    const since = dayStart(Date.now())
    const numbers = this.store.numbers().map((n) => this.view(n, since))
    if (!this.cloudOk) return { numbers, cloud: { available: false, why: this.cloudWhy() } }
    try {
      const base = this.deps.publicUrl!.replace(/\/+$/, '')
      return { numbers, cloud: { available: true, webhookUrl: `${base}/whatsapp/webhook`, verifyToken: await this.verifyToken() } }
    } catch (e) {
      this.fail(e)
      return { numbers, cloud: { available: false, why: L('Não consegui abrir a chave de verificação da Meta neste computador.', "I couldn't open Meta's verification key on this computer.") } }
    }
  }

  private numberView(id: string): WhatsAppNumber {
    return this.view(this.need(id), dayStart(Date.now()))
  }

  // ---------- numbers ----------

  async add(input: WhatsAppNumberInput): Promise<WhatsAppNumber> {
    if (!input || typeof input !== 'object') throw new UserError(L('Faltam os dados do número.', "The number's details are missing."))
    const name = field(input.name, L('O nome', 'The name'), NAME_MAX, true)
    const description = field(input.description, L('A descrição', 'The description'), DESCRIPTION_MAX, false)
    if (input.kind !== 'qr' && input.kind !== 'cloud') throw new UserError(L('Escolha como ligar o número: código QR ou API oficial.', 'Choose how to link the number: QR code or the official API.'))
    const row: NumberRow = { id: randomUUID(), name, description, kind: input.kind, settings: defaultSettings(input.kind), createdAt: Date.now() }
    if (input.kind === 'qr') {
      this.store.addNumber(row)
      this.rt(row.id)
      this.changed()
      // Linking starts now, so the screen already has the code to scan.
      void this.link(row.id).catch((e: unknown) => this.fail(e))
      return this.numberView(row.id)
    }
    if (!this.cloudOk) throw new UserError(this.cloudWhy())
    const c = input.cloud
    const keys = {
      phoneId: field(c?.phoneId, L('O ID do número de telefone', 'The phone number ID'), 40, true),
      wabaId: field(c?.wabaId, L('O ID da conta do WhatsApp Business', 'The WhatsApp Business account ID'), 40, true),
      token: field(c?.token, L('A chave de acesso', 'The access token'), 1000, true),
      appSecret: field(c?.appSecret, L('A chave secreta do app', 'The app secret'), 200, true)
    }
    if (!/^\d+$/.test(keys.phoneId) || !/^\d+$/.test(keys.wabaId)) throw new UserError(L('Os IDs da Meta são só números. Copie de novo do painel da Meta.', "Meta's IDs are numbers only. Copy them again from Meta's panel."))
    if ([...this.keys.values()].some((k) => k.phoneId === keys.phoneId)) throw new UserError(L('Esse número da Meta já foi adicionado.', 'That Meta number was already added.'))
    const checked = await cloud.check(keys.phoneId, keys.token)
    const phone = phoneDigits(checked.phone)
    this.store.addNumber({ ...row, ...(phone ? { phone } : {}) })
    try {
      await this.store.authSet(row.id, [['cloud', JSON.stringify(keys)]])
    } catch (e) {
      this.store.removeNumber(row.id)
      throw e
    }
    this.keys.set(row.id, keys)
    this.changed()
    return this.numberView(row.id)
  }

  async update(id: string, patch: { name?: string; description?: string; settings?: Partial<WhatsAppSettings> }): Promise<WhatsAppNumber> {
    const n = this.need(id)
    const p = patch ?? {}
    const name = p.name === undefined ? undefined : field(p.name, L('O nome', 'The name'), NAME_MAX, true)
    const description = p.description === undefined ? undefined : field(p.description, L('A descrição', 'The description'), DESCRIPTION_MAX, false)
    const settings = p.settings && typeof p.settings === 'object' ? clampSettings(n.kind, { ...n.settings, ...p.settings }) : undefined
    this.store.updateNumber(id, { ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}), ...(settings ? { settings } : {}) })
    this.changed()
    return this.numberView(id)
  }

  async remove(id: string): Promise<void> {
    this.need(id)
    this.removing.add(id) // a connect() during the logout must not open a link for a number that is leaving
    try {
      await Promise.resolve().then(() => this.deps.numberGone?.(id)).catch((e: unknown) => this.fail(e)) // its calls go off at the voice service while the keys and rows still exist
      const r = this.runtimes.get(id)
      this.runtimes.delete(id) // from here on, nothing that number's link says is heard
      this.arrivals.wakes.drop((p) => p.numberId === id)
      this.arrivals.wakes.forget(id)
      try {
        await r?.driver?.logout()
      } catch (e) {
        this.fail(e) // the number leaves either way
      }
      this.keys.delete(id)
      await this.media.remove(this.store.removeNumber(id)) // its messages' files go with it
      await this.media.removeNumber(id)
      this.changed()
    } finally {
      this.removing.delete(id)
    }
  }

  async connect(id: string, phone?: string): Promise<void> {
    const n = this.need(id)
    if (n.kind === 'cloud') {
      const r = this.rt(id)
      try {
        const keys = this.keys.get(id) ?? (await this.openKeys(id))
        if (!keys) throw new UserError(L('Não consegui abrir as chaves deste número. Remova-o e adicione de novo.', "I couldn't open this number's keys. Remove it and add it again."))
        await cloud.check(keys.phoneId, keys.token)
        r.error = undefined
      } catch (e) {
        r.error = e instanceof UserError ? e.message : generic()
        this.changed()
        throw e instanceof UserError ? e : new UserError(generic())
      }
      this.changed()
      return
    }
    let digits: string | undefined
    if (typeof phone === 'string' && phone.trim()) {
      digits = phoneDigits(phone)
      if (!digits) throw new UserError(L('Esse telefone não parece válido. Use o número com código do país, ex.: +55 11 90000-0000.', 'That phone does not look valid. Use the number with country code, e.g. +55 11 90000-0000.'))
    }
    if (this.rt(id).view.status === 'connected' && !digits) return
    await this.link(id, digits)
  }

  // Unlinks the number: it leaves the phone's linked devices and its keys are erased here.
  async disconnect(id: string): Promise<void> {
    const n = this.need(id)
    if (n.kind === 'cloud') throw new UserError(L('O número da API oficial fica sempre ligado. Para parar de usar, tire o acesso dos agentes ou remova o número.', 'An official-API number is always on. To stop using it, take the agents\' access away or remove the number.'))
    const r = this.rt(id)
    const driver = r.driver
    r.driver = undefined
    r.view = { status: 'disconnected' }
    this.arrivals.wakes.drop((p) => p.numberId === id)
    this.changed()
    try {
      await driver?.logout()
    } catch (e) {
      this.fail(e)
    }
    this.store.authClear(id)
    this.changed()
  }

  // The conversations of a number, for the picker: filtered by what was typed, the latest first.
  async chats(id: string, q?: string): Promise<WhatsAppChat[]> {
    const n = this.need(id)
    const query = typeof q === 'string' ? fold(q) : ''
    const digits = typeof q === 'string' ? q.replace(/\D/g, '') : ''
    return this.store
      .chats(n.id)
      .filter((c) => n.kind === 'qr' || c.kind === 'contact')
      .filter((c) => !query || fold(c.name).includes(query) || (digits.length >= 3 && !!c.phone?.includes(digits)))
      .slice(0, 300)
      .map((c) => this.withPause(n.id, c))
  }

  async setAccess(id: string, access: WhatsAppAccess[]): Promise<WhatsAppNumber> {
    const n = this.need(id)
    if (!Array.isArray(access)) throw new UserError(L('Faltam as permissões a salvar.', 'The permissions to save are missing.'))
    const ids = new Set(this.deps.agents().filter((a) => !a.archived).map((a) => a.id))
    let rows = cleanAccess(access, ids)
    // The official API has no groups.
    if (n.kind === 'cloud') rows = rows.filter((a) => a.chat === ALL_CHATS || (this.store.chat(id, a.chat)?.kind !== 'group' && !a.chat.endsWith('@g.us')))
    this.store.setAccess(id, rows)
    this.dropOrphanManagers(n)
    this.changed()
    return this.numberView(id)
  }

  async templates(id: string): Promise<WhatsAppTemplate[]> {
    const n = this.need(id)
    if (n.kind !== 'cloud') throw new UserError(L('Modelos só existem no número da API oficial.', 'Templates only exist on an official-API number.'))
    const keys = this.keys.get(id) ?? (await this.openKeys(id))
    if (!keys) throw new UserError(L('Não consegui abrir as chaves deste número. Remova-o e adicione de novo.', "I couldn't open this number's keys. Remove it and add it again."))
    return cloud.templates(keys)
  }

  // A group manager with no access row left on a number stops being one there: "can manage groups" follows the access.
  private dropOrphanManagers(n: NumberRow): void {
    const withAccess = new Set(this.store.access(n.id).map((a) => a.agentId))
    const kept = n.settings.groupManagers.filter((id) => withAccess.has(id))
    if (kept.length === n.settings.groupManagers.length) return
    this.store.updateNumber(n.id, { settings: clampSettings(n.kind, { ...n.settings, groupManagers: kept }) })
  }

  agentGone(agentId: string): void {
    try {
      this.store.dropAgent(agentId)
      for (const n of this.store.numbers()) this.dropOrphanManagers(n)
      this.arrivals.wakes.drop((p) => p.agentId === agentId)
      this.changed()
    } catch (e) {
      this.fail(e)
    }
  }

  // ---------- earlier messages ----------

  // The screen's "bring earlier messages" button (QR numbers): the phone is asked and they arrive on their own.
  async history(id: string, chat: string): Promise<void> {
    await this.agent.history(this.need(id), chat)
  }

  // ---------- what arrives (inbound.ts stores it and decides the wakes) ----------

  // The message a reply from Meta answers, as far as it is kept here.
  private quotedOf(numberId: string, chat: string, id: string): { id: string; text: string } {
    const q = this.store.message(numberId, chat, id)
    return { id, text: q && !q.deleted ? q.text : '' }
  }

  // Meta's webhook. It never throws: Meta retries what it thinks failed, so every case gets an answer.
  async webhook(req: { method: 'GET' | 'POST'; query: Record<string, string>; body: string; signature?: string }): Promise<{ status: number; body: string }> {
    try {
      if (req.method === 'GET') return cloud.verify(req.query ?? {}, await this.verifyToken())
      if (req.method !== 'POST') return { status: 405, body: 'method not allowed' }
      const raw = typeof req.body === 'string' ? req.body : ''
      const signers: { id: string; keys: cloud.CloudCreds }[] = []
      for (const n of this.store.numbers()) {
        if (n.kind !== 'cloud') continue
        const keys = this.keys.get(n.id) ?? (await this.openKeys(n.id).catch(() => undefined))
        if (keys && cloud.signed(keys.appSecret, raw, req.signature)) signers.push({ id: n.id, keys })
      }
      if (!signers.length) {
        // Unknown signature: no number's app secret matches. Nothing is read.
        return { status: 401, body: 'invalid signature' }
      }
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch {
        // Signed by Meta but not JSON: a 400 would only make Meta send the same body again.
        return { status: 200, body: 'ok' }
      }
      for (const m of cloud.parse(json)) {
        const to = signers.find((s) => s.keys.phoneId === m.phoneId)
        if (!to) continue // a number this app does not know: ignored, and Meta is told all is well
        try {
          const file = m.media
          const quoted = m.quotedId ? this.quotedOf(to.id, m.from, m.quotedId) : undefined
          this.arrivals.message(to.id, {
            chat: m.from,
            id: m.id,
            fromMe: false,
            ours: false,
            group: false,
            live: true,
            chatName: m.name,
            phone: m.from,
            text: m.text,
            at: m.at,
            mentioned: false,
            // Meta gives a media id; the bytes are fetched only if the conversation is kept.
            ...(file ? { media: { kind: file.kind, mime: file.mime, ...(file.fileName ? { fileName: file.fileName } : {}) }, download: async () => (await cloud.download(to.keys, file.id)).data } : {}),
            ...(quoted ? { quoted } : {})
          })
        } catch (e) {
          this.fail(e)
        }
      }
      // Reactions that arrived: they change what is stored, they never wake anyone.
      for (const c of cloud.parseChanges(json)) {
        const to = signers.find((s) => s.keys.phoneId === c.phoneId)
        if (to) this.arrivals.change(to.id, { chat: c.from, target: c.target, kind: 'reaction', emoji: c.emoji, fromMe: false, at: c.at })
      }
      for (const p of cloud.parsePermissions(json)) {
        const to = signers.find((s) => s.keys.phoneId === p.phoneId) // a person's answer to "may we call you"
        try { if (to) this.deps.callPermission?.(to.id, p.from, { accepted: p.accepted, ...(p.until !== undefined ? { until: p.until } : {}) }) } catch (e) { this.fail(e) }
      }
      return { status: 200, body: 'ok' }
    } catch (e) {
      this.fail(e)
      return { status: 200, body: 'ok' } // an internal problem is ours; an error status would only make Meta resend
    }
  }

  // ---------- what an agent does (src/core/runs.ts calls these) ----------

  has(agentId: string): boolean {
    try {
      return this.store.hasAgent(agentId)
    } catch {
      return false
    }
  }

  tools(agentId?: string): ToolDef[] {
    return toolDefs().filter((t) => t.name !== 'whatsapp_ligar' || (!!agentId && this.agent.canDial(agentId))) // calling is offered only where a number lets this agent call
  }

  call(agent: { id: string; name: string }, name: string, args: Record<string, unknown>, ctx?: ToolCtx): Promise<ToolOutcome> {
    return this.agent.call(agent, name, args, ctx)
  }

  approved(agentId: string, args: Record<string, unknown>, tool?: string): Promise<{ ok: boolean; text: string }> {
    return this.agent.approved(agentId, args, tool)
  }

  always(agentId: string, args: Record<string, unknown>): void {
    this.agent.always(agentId, args)
  }

  what(args: Record<string, unknown>, tool?: string): string {
    return this.agent.what(args, tool)
  }
}
