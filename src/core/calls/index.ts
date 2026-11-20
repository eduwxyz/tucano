// Calls on a WhatsApp number of the official API, answered by one of the team's agents. This is what is
// the same for any voice service: who answers, the limits, the opening hours, the card in the
// conversation, what was agreed. What differs between services is behind `VoiceProvider`. Its rule is the
// one of the rest of WhatsApp: nothing a person, a service or Meta sends ever becomes a crash. The two
// public doors (`start`, `tool`) always answer, and every remote failure is a sentence kept as `problem`.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { L } from '../../shared/lang'
import { errorFor, UserError } from '../../shared/errors'
import {
  CALL_LIMITS,
  clampCallSettings,
  defaultCallSettings,
  openNow,
  TURN_TEXT_MAX,
  TURNS_MAX,
  VOICE_PROVIDERS,
  type CallCard,
  type CallSettings,
  type CallsState,
  type CallSetupStep,
  type VoiceChoice,
  type VoiceOption
} from '../../shared/calls'
import { ALL_CHATS, dayStart, type WhatsAppChat, type WhatsAppMessage, type WhatsAppSettings } from '../../shared/whatsapp'
import * as cloud from '../whatsapp/cloud'
import type { CallRow, WhatsAppStore } from '../whatsapp/store'
import { ElevenLabs } from './elevenlabs'
import { buildPrompt, braceSafe, defaultGreeting } from './prompt'
import { digits, MAX_LIVE, STATE_KEY, text } from './common'
import { answerPermission, dialAgent, type OutboundCtx } from './outbound'
import type { ProviderState, VoiceProvider } from './provider'
import { WakeCap, Watcher } from './watch'

export type { ProviderState, VoiceProvider } from './provider'
export { buildPrompt, defaultGreeting } from './prompt'

const DOOR_KEYS = { start: 'calls:start', tool: 'calls:tool' } // the two door secrets, sealed under number '' (one for the whole workspace)
const WATCH_MS = 15_000
const WIKI_MAX = 6_000
const CHAT_MESSAGES = 30
const AGREED_MAX = 20
const AGREED_TEXT_MAX = 500
const SUMMARY_MAX = 2_000
const WAKES_PER_DAY = 30 // most times finished calls may wake their agent, per number and day

export interface NumberView {
  id: string
  name: string
  kind: 'qr' | 'cloud'
  phone?: string
  settings: WhatsAppSettings
}

export interface CallsDeps {
  store: WhatsAppStore // calls table, sealed state; the settings live in the number's settings
  publicUrl?: string
  number(id: string): NumberView | undefined
  numbers(): NumberView[]
  saveCallSettings(numberId: string, s: CallSettings): void
  cloud(numberId: string): cloud.CloudCreds | undefined
  connector(provider: 'elevenlabs'): { id: string; connected: boolean } | undefined // found by address among the connectors
  tool(connectorId: string, name: string, args: Record<string, unknown>): Promise<unknown>
  agent(id: string): { id: string; name: string; role: string; instructions: string; archived?: boolean; wiki: boolean } | undefined
  access(numberId: string, agentId: string, chat: string): 'read' | 'reply' | undefined
  chat(numberId: string, chat: string): WhatsAppChat | undefined
  messages(numberId: string, chat: string, limit: number): WhatsAppMessage[]
  wiki(agentId: string, query: string): string // what the agent's own wiki search returns, as text; '' when it has no wiki
  language(): string
  workspace(): string
  card(agentId: string, card: CallCard, existingMessageId?: string): string | undefined // posts or updates the call's message; returns its id
  wake(agentId: string, card: CallCard): void // after the call: the agent reads the card and does what was agreed
  changed(): void
}

type Reply = { status: number; body: string }

// Equal-length digests are compared, so neither the content nor the length of the secret leaks through timing.
const sameSecret = (given: string, expected: string): boolean => timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest())

export class Calls {
  private voiceService?: VoiceProvider
  private doorSecrets?: { start: string; tool: string }
  private problems = new Map<string, string>() // the last thing that went wrong, per number
  private steps = new Map<string, CallSetupStep>() // while a number is being prepared
  private busy = new Set<string>() // numbers being prepared or removed
  private asked = new Map<string, number>() // when a person was last asked for call permission
  private rejected = new Map<string, number>() // when a person last declined calls, per number and chat
  private wakes = new WakeCap(WAKES_PER_DAY) // finished calls that woke their agent, per number and day
  private watcher: Watcher

  constructor(private deps: CallsDeps) {
    this.watcher = new Watcher(WATCH_MS, (id) => this.follow(id))
    // Calls that were on when the app closed are followed again; one that can't be followed is closed now.
    try {
      for (const c of deps.store.liveCalls()) {
        if (c.conversationId) this.watcher.add(c.id)
        else deps.store.updateCall(c.id, { state: 'failed', note: L('A ligação não pôde ser acompanhada.', 'The call could not be followed.') })
      }
    } catch (e) {
      this.log(e)
    }
  }

  stop(): void {
    this.watcher.stop()
  }

  // An archived agent stops answering: the numbers it answered refuse calls until someone picks another.
  agentGone(agentId: string): void {
    try {
      for (const n of this.deps.numbers()) if (n.settings.calls?.agentId === agentId) this.deps.saveCallSettings(n.id, { ...n.settings.calls, agentId: undefined })
      this.deps.changed()
    } catch (e) {
      this.log(e)
    }
  }

  private log(e: unknown): void {
    console.error('[calls]', e instanceof Error ? e.message : String(e))
  }

  // A trunk that couldn't be removed stays at the voice service. Its ids go to the log (never a secret), so it can be removed by hand.
  private stranded(provider: CallSettings['provider'], made: ProviderState, e: unknown): void {
    this.log(e)
    console.error('[calls]', `${VOICE_PROVIDERS[provider].name} still has phone number ${made.phoneNumberId} and attendant ${made.agentId}; remove them there by hand`)
  }

  // ---------- pieces ----------

  private service(): VoiceProvider {
    return (this.voiceService ??= new ElevenLabs((name, args) => {
      const c = this.deps.connector('elevenlabs')
      if (!c?.connected) return Promise.reject(new UserError(L('O ElevenLabs não está conectado. Conecte-o na loja de conectores.', 'ElevenLabs is not connected. Connect it in the connector store.')))
      return this.deps.tool(c.id, name, args)
    }))
  }

  private need(id: string): NumberView {
    const n = this.deps.number(id)
    if (!n) throw new UserError(L('Esse número de WhatsApp não existe mais.', 'That WhatsApp number no longer exists.'))
    return n
  }

  private settingsOf(n: NumberView): CallSettings {
    return n.settings.calls ? clampCallSettings(n.settings.calls) : defaultCallSettings()
  }

  // What is missing for this number to take calls at all, in words.
  private why(n: NumberView): string | undefined {
    if (n.kind !== 'cloud') return L('Ligações só funcionam em números da API oficial da Meta. Um número ligado por QR code não recebe ligações pelo Tucano.', 'Calls only work on numbers of Meta\'s official API. A number linked by QR code can\'t take calls through Tucano.')
    if (!this.deps.publicUrl?.startsWith('https://')) return L('Ligações precisam de um servidor com endereço https, para a Meta e o ElevenLabs conseguirem falar com o Tucano.', 'Calls need a server with an https address, so Meta and ElevenLabs can reach Tucano.')
    if (!digits(n.phone)) return L('A Meta ainda não confirmou o telefone deste número. Salve os dados do número de novo.', "Meta hasn't confirmed this number's phone yet. Save the number's details again.")
    return undefined
  }

  // The two door secrets are made once and shared by every number: the voice service keeps one attendant (and so one header) for all of them.
  private async doors(create: boolean): Promise<{ start: string; tool: string } | undefined> {
    if (this.doorSecrets) return this.doorSecrets
    const s = this.deps.store
    let start = await s.authGet('', DOOR_KEYS.start)
    let tool = await s.authGet('', DOOR_KEYS.tool)
    if ((!start || !tool) && create) {
      start ??= randomBytes(32).toString('base64url')
      tool ??= randomBytes(32).toString('base64url')
      await s.authSet('', [
        [DOOR_KEYS.start, start],
        [DOOR_KEYS.tool, tool]
      ])
    }
    if (!start || !tool) return undefined
    return (this.doorSecrets = { start, tool })
  }

  private async providerState(numberId: string): Promise<ProviderState | undefined> {
    try {
      const raw = await this.deps.store.authGet(numberId, STATE_KEY)
      const s = raw ? (JSON.parse(raw) as Partial<ProviderState>) : undefined
      if (!s || typeof s.agentId !== 'string' || typeof s.phoneNumberId !== 'string') return undefined
      const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
      return { agentId: s.agentId, phoneNumberId: s.phoneNumberId, toolIds: list(s.toolIds), secretIds: list(s.secretIds) }
    } catch {
      return undefined // unreadable is as good as none: the number is prepared again
    }
  }

  // The agent that answers: the one chosen when it still may, else the first that may reply on the number.
  private answering(numberId: string, preferred?: string): { id: string; name: string } | undefined {
    const live = (id: string): { id: string; name: string } | undefined => {
      const a = this.deps.agent(id)
      return a && !a.archived ? a : undefined
    }
    const rows = this.deps.store.access(numberId).filter((r) => r.level === 'reply')
    if (preferred && rows.some((r) => r.agentId === preferred)) {
      const a = live(preferred)
      if (a) return a
    }
    for (const r of [...rows].sort((a, b) => Number(b.chat === ALL_CHATS) - Number(a.chat === ALL_CHATS))) {
      const a = live(r.agentId)
      if (a) return a
    }
    return undefined
  }

  private cardOf(row: CallRow): CallCard {
    const known = this.deps.chat(row.numberId, row.chat)?.name
    return {
      id: row.id,
      numberId: row.numberId,
      numberName: this.deps.number(row.numberId)?.name ?? '',
      chat: row.chat,
      person: known && !/^\+?\d+$/.test(known) ? known : `+${digits(row.chat)}`,
      direction: row.direction,
      state: row.state,
      startedAt: row.startedAt,
      ...(row.state !== 'live' ? { seconds: row.seconds } : {}),
      ...(row.summary ? { summary: row.summary } : {}),
      ...(row.agreed.length ? { agreed: row.agreed } : {}),
      ...(row.turns.length ? { turns: row.turns } : {}),
      ...(row.note ? { note: row.note } : {})
    }
  }

  // Posts the call's message in the agent's conversation, or updates it. A failure here never touches the call.
  private post(row: CallRow): void {
    try {
      const id = this.deps.card(row.agentId, this.cardOf(row), row.messageId)
      if (id && id !== row.messageId) {
        row.messageId = id
        this.deps.store.updateCall(row.id, { messageId: id })
      }
    } catch (e) {
      this.log(e)
    }
  }

  // Keeps a new call, posts its card and, when it is on, follows it.
  private open(row: CallRow): void {
    this.deps.store.putCall(row)
    this.post(row)
    if (row.state === 'live') this.watcher.add(row.id)
    this.deps.changed()
  }

  private recent(numberId: string, agentId: string, chat: string): { fromMe: boolean; text: string }[] {
    try {
      if (!this.deps.access(numberId, agentId, chat)) return []
      return this.deps.messages(numberId, chat, 12).map((m) => ({ fromMe: m.fromMe, text: m.text }))
    } catch {
      return []
    }
  }

  // ---------- what the screen reads and does ----------

  async state(numberId: string): Promise<CallsState> {
    const n = this.need(numberId)
    const settings = this.settingsOf(n)
    const why = this.why(n)
    const connector = this.deps.connector(settings.provider)
    const problem = this.problems.get(numberId)
    return {
      available: !why,
      ...(why ? { why } : {}),
      provider: { id: settings.provider, name: VOICE_PROVIDERS[settings.provider].name, connected: connector?.connected === true },
      ready: settings.enabled && this.deps.store.hasAuth(numberId, STATE_KEY),
      settings,
      usedToday: this.deps.store.minutesToday(numberId, dayStart(Date.now())),
      ...(problem ? { problem } : {})
    }
  }

  // Where the setup of a number is, while `enable` runs (the screen reads it with `state`).
  step(numberId: string): CallSetupStep | undefined {
    return this.steps.get(numberId)
  }

  // Prepares the voice service and Meta. A remote failure is undone as far as possible and kept as `problem`;
  // what is missing before anything is tried (a server, a connector, an agent) is a sentence thrown.
  async enable(numberId: string, onStep?: (s: CallSetupStep) => void): Promise<CallsState> {
    const n = this.need(numberId)
    const why = this.why(n)
    if (why) throw new UserError(why)
    const settings = this.settingsOf(n)
    const keys = this.deps.cloud(numberId)
    if (!keys) throw new UserError(L('Não achei a chave da API oficial deste número. Confira os dados do número.', "I can't find this number's official API key. Check the number's details."))
    if (!this.deps.connector(settings.provider)?.connected) throw new UserError(L('Conecte o ElevenLabs na loja de conectores antes de ligar as ligações.', 'Connect ElevenLabs in the connector store before turning calls on.'))
    const agent = this.answering(numberId, settings.agentId)
    if (!agent) throw new UserError(L('Nenhum agente pode responder neste número ainda. Dê a um agente o acesso de responder e tente de novo.', 'No agent may answer on this number yet. Give an agent reply access and try again.'))
    if (this.busy.has(numberId)) throw new UserError(L('Já estou ligando as ligações deste número. Espere um instante.', "I'm already turning calls on for this number. Wait a moment."))
    this.busy.add(numberId)
    this.problems.delete(numberId)
    const step = (s: CallSetupStep): void => {
      this.steps.set(numberId, s)
      try {
        onStep?.(s)
      } catch {
        // the listener is the screen's business
      }
      this.deps.changed()
    }
    const provider = this.service()
    let metaOn = false
    let made: ProviderState | undefined
    try {
      step('connector')
      const doors = await this.doors(true)
      if (!doors) throw new UserError(L('Não consegui guardar os códigos de segurança das ligações.', "I couldn't keep the calls' security codes."))
      const base = this.deps.publicUrl!.replace(/\/+$/, '')
      await cloud.callingOn(keys, { ...provider.sip, ...(settings.hours.on ? { hours: settings.hours } : {}) })
      metaOn = true
      const sipPassword = await cloud.sipPassword(keys)
      made = await provider.prepare({
        number: `+${digits(n.phone)}`,
        label: n.name.slice(0, 60),
        sipUser: digits(n.phone),
        sipPassword,
        urls: { start: `${base}/calls/start`, tool: `${base}/calls/tool` },
        secrets: doors,
        maxSeconds: settings.minutesPerCall * 60,
        ...(await this.providerState(numberId).then((known) => (known ? { known } : {}))),
        onStep: step
      })
      await this.deps.store.authSet(numberId, [[STATE_KEY, JSON.stringify(made)]])
      this.deps.saveCallSettings(numberId, { ...settings, enabled: true, agentId: agent.id })
      step('done')
    } catch (e) {
      this.log(e)
      // Undo what was done, each part on its own: one that can't be undone must not keep the others.
      if (made) {
        const left = made
        await provider.teardown(left).catch((x: unknown) => this.stranded(settings.provider, left, x))
      }
      if (metaOn) await cloud.callingOff(keys).catch((x: unknown) => this.log(x))
      await this.deps.store.authSet(numberId, [[STATE_KEY, undefined]]).catch((x: unknown) => this.log(x))
      try {
        this.deps.saveCallSettings(numberId, { ...settings, enabled: false })
      } catch (x) {
        this.log(x)
      }
      this.problems.set(numberId, errorFor(e, true))
    } finally {
      this.busy.delete(numberId)
      this.steps.delete(numberId)
      this.deps.changed()
    }
    return this.state(numberId)
  }

  // Turns calls off at Meta and removes the number at the voice service. Locally it is off whatever happens:
  // a call that still reaches the voice service is refused at the door.
  async disable(numberId: string): Promise<CallsState> {
    const n = this.need(numberId)
    if (this.busy.has(numberId)) throw new UserError(L('Este número está sendo mexido agora. Espere um instante.', 'This number is being changed right now. Wait a moment.'))
    this.busy.add(numberId)
    try {
      const settings = this.settingsOf(n)
      const trouble: string[] = []
      const keys = this.deps.cloud(numberId)
      if (keys) await cloud.callingOff(keys).catch((e: unknown) => trouble.push(errorFor(e, true)))
      const made = await this.providerState(numberId)
      let removed = true
      if (made)
        await this.service()
          .teardown(made)
          .catch((e: unknown) => {
            removed = false
            trouble.push(errorFor(e, true))
            this.stranded(settings.provider, made, e)
          })
      if (removed) await this.deps.store.authSet(numberId, [[STATE_KEY, undefined]]) // kept when it couldn't be removed, so a second try can finish
      this.deps.saveCallSettings(numberId, { ...settings, enabled: false })
      if (trouble.length) this.problems.set(numberId, L(`Desliguei as ligações aqui, mas faltou limpar do outro lado: ${trouble[0]}`, `Calls are off here, but cleaning up the other side didn't finish: ${trouble[0]}`))
      else this.problems.delete(numberId)
    } catch (e) {
      this.problems.set(numberId, errorFor(e, true))
    } finally {
      this.busy.delete(numberId)
      this.deps.changed()
    }
    return this.state(numberId)
  }

  // Saves what the screen asks (inside the limits) and tells the other sides what changed. `enabled` and the service
  // are not set here: `enable` and `disable` do that.
  async update(numberId: string, patch: Partial<CallSettings>): Promise<CallsState> {
    const n = this.need(numberId)
    this.problems.delete(numberId) // a problem is kept only while the update that caused it is the last one
    const cur = this.settingsOf(n)
    const given = Object.fromEntries(Object.entries(patch ?? {}).filter(([, v]) => v !== undefined)) as Partial<CallSettings>
    const next = clampCallSettings({ ...cur, ...given, hours: given.hours ? { ...cur.hours, ...given.hours } : cur.hours, enabled: cur.enabled, provider: cur.provider })
    if (given.agentId && given.agentId !== cur.agentId) {
      if (!this.deps.agent(given.agentId) || this.deps.agent(given.agentId)?.archived) throw new UserError(L('Esse agente não existe mais.', 'That agent no longer exists.'))
      if (!this.deps.store.access(numberId).some((r) => r.agentId === given.agentId && r.level === 'reply')) throw new UserError(L('Esse agente ainda não pode responder neste número. Dê a ele o acesso de responder primeiro.', "That agent can't answer on this number yet. Give it reply access first."))
    }
    this.deps.saveCallSettings(numberId, next)
    if (cur.enabled) {
      const trouble: string[] = []
      const keys = this.deps.cloud(numberId)
      if (keys && JSON.stringify(cur.hours) !== JSON.stringify(next.hours)) await cloud.callingOn(keys, { ...this.service().sip, ...(next.hours.on ? { hours: next.hours } : {}) }).catch((e: unknown) => trouble.push(errorFor(e, true)))
      const made = cur.minutesPerCall !== next.minutesPerCall ? await this.providerState(numberId) : undefined
      if (made) await this.service().update(made, { maxSeconds: next.minutesPerCall * 60 }).catch((e: unknown) => trouble.push(errorFor(e, true)))
      if (trouble.length) this.problems.set(numberId, L(`Salvei, mas não consegui avisar o outro lado: ${trouble[0]}`, `Saved, but I couldn't tell the other side: ${trouble[0]}`))
    }
    this.deps.changed()
    return this.state(numberId)
  }

  voices(q?: string): Promise<VoiceOption[]> {
    return this.service().voices(q)
  }

  voice(agentId: string): VoiceChoice | undefined {
    try {
      return this.deps.store.voice(agentId)
    } catch {
      return undefined
    }
  }

  setVoice(agentId: string, v: VoiceChoice | null): void {
    if (v !== null) {
      const ok = v && typeof v === 'object' && v.provider in VOICE_PROVIDERS && typeof v.voiceId === 'string' && /^[\w-]{1,100}$/.test(v.voiceId) && typeof v.name === 'string' && v.name.trim() && v.name.length <= 120
      if (!ok) throw new UserError(L('Essa voz não é válida. Escolha uma da lista.', "That voice isn't valid. Pick one from the list."))
    }
    this.deps.store.setVoice(agentId, v)
    this.deps.changed()
  }

  // ---------- the doors the voice service calls ----------

  // "A call is starting": answered from what is here, within about a second, with no remote call. A 403 is how a call is refused.
  async start(secret: string, body: string): Promise<Reply> {
    try {
      const doors = await this.doors(false)
      if (!doors || !sameSecret(secret, doors.start)) return { status: 403, body: 'forbidden' }
      let json: unknown
      try {
        json = JSON.parse(body)
      } catch {
        return { status: 403, body: '' } // an unreadable body is refused like any other: nothing here looks like our error
      }
      const req = this.service().readStart(json)
      if (!req) return { status: 403, body: '' }
      return this.begin(req)
    } catch (e) {
      this.log(e)
      return { status: 503, body: 'unavailable' }
    }
  }

  private begin(req: { conversationId: string; caller: string; called: string }): Reply {
    const refuse: Reply = { status: 403, body: 'forbidden' }
    const called = digits(req.called)
    const chat = digits(req.caller)
    const n = called ? this.deps.numbers().find((x) => x.kind === 'cloud' && digits(x.phone) === called) : undefined
    if (!n || !chat) return refuse
    const settings = this.settingsOf(n)
    const now = Date.now()
    if (!settings.enabled || !this.deps.store.hasAuth(n.id, STATE_KEY) || !openNow(settings.hours, now)) return refuse
    const agent = settings.agentId ? this.deps.agent(settings.agentId) : undefined
    if (!agent || agent.archived) return refuse
    // The agent chosen to answer must still be allowed to: a reply access taken away on this number ends its answering here.
    if (!this.deps.store.access(n.id).some((r) => r.agentId === agent.id && r.level === 'reply')) {
      this.problems.set(n.id, L('O agente escolhido para atender não tem mais "Ler e responder" neste número. Dê a ele esse acesso ou escolha outro agente.', 'The agent chosen to answer no longer has "Read and answer" on this number. Give it that access or pick another agent.'))
      this.deps.changed()
      return refuse
    }
    const retry = this.deps.store.callByConversation(req.conversationId) // the service asks twice now and then: the second gets the same answer
    if (!retry) {
      if (this.deps.store.minutesToday(n.id, dayStart(now)) >= settings.minutesPerDay) return refuse
      if (this.deps.store.liveCalls(n.id, now - (settings.minutesPerCall + 5) * 60_000).length >= MAX_LIVE) return refuse
    }
    const lang = this.deps.language() === 'pt' ? 'pt' : 'en'
    const person = { name: this.deps.chat(n.id, chat)?.name ?? '', phone: chat }
    const voiceId = this.deps.store.voice(agent.id)?.voiceId
    const reply = this.service().startReply({
      prompt: buildPrompt({ agent, team: this.deps.workspace(), person, numberName: n.name, recent: this.recent(n.id, agent.id, chat), language: lang, minutesPerCall: settings.minutesPerCall }),
      firstMessage: braceSafe(settings.greeting || defaultGreeting({ name: agent.name, language: lang })),
      language: lang,
      toolIds: [],
      variables: {},
      maxSeconds: settings.minutesPerCall * 60,
      ...(voiceId ? { voiceId } : {})
    })
    if (!retry) {
      const row: CallRow = { id: randomUUID(), numberId: n.id, chat, agentId: agent.id, conversationId: req.conversationId, direction: 'in', state: 'live', startedAt: now, seconds: 0, agreed: [], turns: [] }
      this.open(row)
    }
    return { status: 200, body: JSON.stringify(reply) }
  }

  // What the attendant can do during a call. Always answers 200 with something the voice model can say; never sends or changes anything.
  async tool(secret: string, name: string, body: string): Promise<Reply> {
    const say = (result: string): Reply => ({ status: 200, body: JSON.stringify({ result }) })
    try {
      const doors = await this.doors(false)
      if (!doors || !sameSecret(secret, doors.tool)) return { status: 403, body: 'forbidden' }
      let json: unknown
      try {
        json = JSON.parse(body)
      } catch {
        return say(L('Não entendi o pedido.', "I didn't understand the request."))
      }
      const req = this.service().readTool(json)
      if (!req) return say(L('Não entendi o pedido.', "I didn't understand the request."))
      const call = this.deps.store.callByConversation(req.conversationId)
      if (!call || call.state !== 'live') return say(L('Não encontrei essa ligação.', "I couldn't find that call."))
      switch (name) {
        case 'consultar_wiki': {
          const q = text(req.args['busca']).slice(0, 300)
          if (!q) return say(L('Diga o que quer procurar.', 'Say what to look for.'))
          const found = this.deps.wiki(call.agentId, q).trim()
          return say(found ? found.slice(0, WIKI_MAX) : L('Não achei nada sobre isso.', 'I found nothing about that.'))
        }
        case 'ver_conversa': {
          if (!this.deps.access(call.numberId, call.agentId, call.chat)) return say(L('Não posso ver as mensagens dessa pessoa.', "I can't see this person's messages."))
          const lines = this.deps.messages(call.numberId, call.chat, CHAT_MESSAGES).filter((m) => m.text.trim()).map((m) => `${m.fromMe ? L('Nós', 'Us') : L('Pessoa', 'Person')}: ${m.text.trim().replace(/\s+/g, ' ').slice(0, 400)}`)
          return say(lines.length ? lines.join('\n').slice(0, WIKI_MAX) : L('Não há mensagens recentes dessa pessoa.', 'There are no recent messages from this person.'))
        }
        case 'anotar_recado': {
          const note = text(req.args['texto']).slice(0, AGREED_TEXT_MAX)
          if (!note) return say(L('Diga o que anotar.', 'Say what to write down.'))
          if (call.agreed.length >= AGREED_MAX) return say(L('Já anotei o máximo de combinados nesta ligação.', 'I have already written down the most agreements this call allows.'))
          const row = this.deps.store.updateCall(call.id, { agreed: [...call.agreed, note] })
          if (row) this.post(row)
          this.deps.changed()
          return say(L('Anotado.', 'Noted.'))
        }
        default:
          return say(L('Isso eu não sei fazer.', "I can't do that."))
      }
    } catch (e) {
      this.log(e)
      return say(L('Não consegui fazer isso agora.', "I couldn't do that right now."))
    }
  }

  // ---------- an agent calls a person ----------

  async dial(agentId: string, args: Record<string, unknown>, dry = false): Promise<{ ok: boolean; text: string }> {
    return dialAgent(this.outboundCtx(), agentId, args, dry)
  }

  // What the outbound calls lend to outbound.ts: the voice service, the permission bookkeeping and this class's own pieces.
  private outboundCtx(): OutboundCtx {
    return { deps: this.deps, service: this.service(), asked: this.asked, rejected: this.rejected, settingsOf: (n) => this.settingsOf(n), providerState: (id) => this.providerState(id), recent: (id, a, c) => this.recent(id, a, c), open: (row) => this.open(row), log: (e) => this.log(e) }
  }

  // The person's answer to "may we call you" (it comes by Meta's webhook).
  permission(numberId: string, chat: string, reply: { accepted: boolean; until?: number }): void {
    answerPermission(this.outboundCtx(), numberId, chat, reply)
  }

  // ---------- after the call ----------

  // True when the call is closed (or can't be followed any more).
  private async follow(id: string): Promise<boolean> {
    const row = this.deps.store.call(id)
    if (!row || row.state !== 'live') return true
    const n = this.deps.number(row.numberId)
    const minutes = (n ? this.settingsOf(n).minutesPerCall : CALL_LIMITS.minutesPerCall) + 5
    if (!row.conversationId) return this.close(row, undefined, minutes)
    let result: Awaited<ReturnType<VoiceProvider['result']>>
    try {
      result = await this.service().result(row.conversationId)
    } catch (e) {
      this.log(e) // the service can't be reached now: it is asked again until the time runs out
    }
    if (result) return this.close(row, result, minutes)
    return Date.now() > row.startedAt + minutes * 60_000 ? this.close(row, undefined, minutes) : false
  }

  // Keeps what the service says of the call (inside the caps), updates the card, and wakes the agent when something is owed.
  private close(row: CallRow, result: Awaited<ReturnType<VoiceProvider['result']>>, minutes: number): true {
    const turns = (result?.turns ?? []).slice(0, TURNS_MAX).map((t) => ({ who: t.who, text: t.text.slice(0, TURN_TEXT_MAX) }))
    const seconds = result ? result.seconds : (minutes - 5) * 60 // unread: counted as a whole call, so the day's limit stays safe
    const spoke = turns.some((t) => t.who === 'person')
    // Nobody picked up: missed. Picked up but the person said nothing: done, and the card says so. Unread: done with its note.
    const pickedUp = result !== undefined && (result.seconds > 0 || spoke)
    const done = this.deps.store.updateCall(row.id, {
      state: result !== undefined && !pickedUp ? 'missed' : 'done',
      seconds,
      turns,
      ...(result?.summary ? { summary: result.summary.slice(0, SUMMARY_MAX) } : {}),
      ...(!result ? { note: L('Não consegui ler os detalhes desta ligação no ElevenLabs.', "I couldn't read this call's details from ElevenLabs.") } : pickedUp && !spoke ? { note: L('Ninguém falou nesta ligação.', 'Nobody spoke on this call.') } : {})
    })
    if (done) {
      this.post(done)
      try {
        // A wake is a run of the agent: only a call with something to act on, and at most WAKES_PER_DAY a day per number.
        const owed = done.state === 'done' && (!!done.summary || done.agreed.length > 0)
        if (owed && this.wakes.take(done.numberId, Date.now())) this.deps.wake(done.agentId, this.cardOf(done))
      } catch (e) {
        this.log(e)
      }
    }
    this.deps.changed()
    return true
  }
}
