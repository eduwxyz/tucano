// ElevenLabs as the voice of the calls, reached only through the connector the person already connected
// in Tucano (never an API key). It makes ONE generic "attendant" there; at the start of every call the
// attendant asks Tucano who answers (the "a call is starting" webhook) and Tucano replies with the
// agent's goal, behaviour, first sentence, language and voice. Nothing here has run against a real
// account: every answer of the connector is read defensively, and every failure is a sentence.
import { randomBytes } from 'node:crypto'
import { L } from '../../shared/lang'
import { UserError } from '../../shared/errors'
import type { CallTurn, VoiceOption } from '../../shared/calls'
import { FIRST_VAR, PROMPT_VAR, type PrepareInput, type ProviderState, type VoiceProvider } from './provider'

const TIMEOUT_MS = 30_000
const ATTENDANT = 'Tucano · atendente'
const HEADER = 'x-tucano-secret'
const SECRET_NAMES = { start: 'tucano_start_secret', tool: 'tucano_tool_secret' }
const META_SIP = 'wa.meta.vc' // where the service sends the calls Tucano places
const STILL_GOING = ['initiated', 'in-progress', 'in_progress', 'processing', 'started', 'ringing']
const VOICES_MAX = 30

// The connector's tool call, already parsed from the MCP result (the first JSON block, or the text).
export type ToolCall = (name: string, args: Record<string, unknown>) => Promise<unknown>

const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)

// The first of these fields that holds text (or a number, as text).
const pick = (o: unknown, ...keys: string[]): string => {
  const r = rec(o)
  for (const k of keys) {
    const v = r?.[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return ''
}

// The list inside an answer, whatever it is called: the answer itself, a known key, or the first array it has.
function rows(v: unknown): Record<string, unknown>[] {
  const r = rec(v)
  const list = Array.isArray(v) ? v : r ? (['agents', 'tools', 'secrets', 'phone_numbers', 'voices', 'items', 'results', 'data'].map((k) => r[k]).find(Array.isArray) ?? Object.values(r).find(Array.isArray)) : undefined
  return ((list as unknown[] | undefined) ?? []).filter((x): x is Record<string, unknown> => rec(x) !== undefined)
}

// A tool lists its name either on top or inside its configuration.
const nameOf = (r: Record<string, unknown>): string => pick(r, 'name') || pick(r['tool_config'], 'name')

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })

// ---------- what the service sends and wants back (pure) ----------

export function parseConversation(v: unknown): { seconds: number; summary?: string; turns: CallTurn[] } | undefined {
  const r = rec(v)
  if (!r) return undefined
  const status = pick(r, 'status').toLowerCase()
  const meta = rec(r['metadata'])
  const transcript = Array.isArray(r['transcript']) ? r['transcript'] : []
  if (STILL_GOING.includes(status) || (!status && !meta && transcript.length === 0)) return undefined
  const turns: CallTurn[] = []
  let last = 0
  for (const t of transcript) {
    const x = rec(t)
    const said = pick(x, 'message', 'text')
    const at = Number(x?.['time_in_call_secs'])
    if (Number.isFinite(at)) last = Math.max(last, at)
    if (said) turns.push({ who: pick(x, 'role') === 'agent' ? 'agent' : 'person', text: said })
  }
  const length = Number(meta?.['call_duration_secs'] ?? meta?.['duration_secs'])
  const summary = pick(r['analysis'], 'transcript_summary', 'call_summary')
  return { seconds: Math.max(0, Math.round(Number.isFinite(length) ? length : last)), ...(summary ? { summary } : {}), turns }
}

// "feminina · calma": what a person can use to tell the voices apart.
function describe(o: Record<string, unknown>): string {
  const labels = rec(o['labels'])
  const gender = pick(labels, 'gender')
  const parts = [gender === 'female' ? L('feminina', 'female') : gender === 'male' ? L('masculina', 'male') : gender, pick(labels, 'descriptive', 'descriptives', 'age', 'accent')].filter(Boolean)
  return parts.length ? parts.join(' · ') : pick(o, 'description').slice(0, 80)
}

export function parseVoices(v: unknown): VoiceOption[] {
  const out: VoiceOption[] = []
  for (const o of rows(v)) {
    const voiceId = pick(o, 'voice_id', 'voiceId', 'id')
    const name = pick(o, 'name')
    if (!voiceId || !name) continue
    const preview = pick(o, 'preview_url', 'previewUrl', 'preview')
    const description = describe(o)
    out.push({ voiceId, name, ...(description ? { description } : {}), ...(preview.startsWith('https://') ? { preview } : {}) })
    if (out.length >= VOICES_MAX) break
  }
  return out
}

// What may be a credential inside a service's message: it is never shown or logged.
const CREDENTIAL = /(sk_[A-Za-z0-9]{8,}|[A-Za-z0-9_-]{32,})/g

// A failed call to the connector, as a sentence. Ours (not connected, timeout) pass through. The service's own words
// are shown to the person, so they are cut short and stripped of anything that looks like a key first.
function refused(e: unknown): UserError {
  if (e instanceof UserError) return e
  const why = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').replace(CREDENTIAL, '…').trim().slice(0, 160)
  return new UserError(L(`O ElevenLabs recusou${why ? `: ${why}` : '.'}`, `ElevenLabs refused${why ? `: ${why}` : '.'}`))
}

const gone = (e: unknown): boolean => /not.?found|404|does not exist|já foi|no such/i.test(e instanceof Error ? e.message : String(e))

export class ElevenLabs implements VoiceProvider {
  readonly id = 'elevenlabs' as const
  readonly sip = { hostname: 'sip.rtc.elevenlabs.io', port: 5061 }

  constructor(private tool: ToolCall) {}

  // Every call has a timeout and any failure becomes a UserError.
  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        this.tool(name, args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new UserError(L('O ElevenLabs demorou demais para responder. Tente de novo.', 'ElevenLabs took too long to answer. Try again.'))), TIMEOUT_MS)
          timer.unref()
        })
      ])
    } catch (e) {
      throw refused(e)
    } finally {
      clearTimeout(timer)
    }
  }

  private missing(what: string): UserError {
    return new UserError(L(`O ElevenLabs não devolveu ${what}. Tente de novo.`, `ElevenLabs did not return ${what}. Try again.`))
  }

  // ---------- setting up ----------

  async prepare(p: PrepareInput): Promise<ProviderState> {
    p.onStep?.('attendant')
    const secrets = { start: await this.secret(SECRET_NAMES.start, p.secrets.start), tool: await this.secret(SECRET_NAMES.tool, p.secrets.tool) }
    const agentId = await this.attendant(p.known?.agentId)
    const toolIds = await this.tools(p.urls.tool, secrets.tool)
    // The attendant's own words are variables: a call Tucano places fills them, one the service receives overrides them.
    await this.call('agents_update_prompt_settings', { agent_id: agentId, prompt: `{{${PROMPT_VAR}}}`, tool_ids: toolIds })
    await this.call('agents_update_agent_behavior', {
      agent_id: agentId,
      first_message: `{{${FIRST_VAR}}}`,
      dynamic_variables: { dynamic_variable_placeholders: { [PROMPT_VAR]: L('Esta ligação não pôde ser preparada. Peça desculpas com educação e encerre a ligação.', 'This call could not be prepared. Apologise politely and end the call.'), [FIRST_VAR]: L('Desculpe, não consigo atender agora. Tente de novo mais tarde.', "Sorry, I can't take your call right now. Please try again later.") } }
    })
    await this.overrides(agentId, p.urls.start, secrets.start)
    p.onStep?.('number')
    const phoneNumberId = await this.trunk(agentId, p)
    await this.update({ agentId, phoneNumberId, toolIds, secretIds: [] }, { maxSeconds: p.maxSeconds })
    return { agentId, phoneNumberId, toolIds, secretIds: [secrets.start, secrets.tool] }
  }

  // A secret the service keeps for its calls to Tucano (the value is never returned): found by its name, or made.
  private async secret(name: string, value: string): Promise<string> {
    const found = rows(await this.call('agents_list_secrets', {})).find((r) => pick(r, 'name') === name)
    const id = pick(found, 'secret_id', 'id')
    let secretName = name
    if (id) {
      // Replace the value so a lost copy on our side never leaves the two apart. If the service won't take it, the old
      // value would stay and every call would be refused without a word, so a new secret is made under a fresh name.
      const replaced = await this.call('agents_update_secret', { secret_id: id, name, value }).then(() => true, () => false)
      if (replaced) return id
      secretName = `${name}_${randomBytes(3).toString('hex')}`
    }
    // A failure here is the UserError from call(), the sentence the person sees.
    const made = pick(await this.call('agents_create_secret', { name: secretName, value }), 'secret_id', 'id')
    if (!made) throw this.missing(L('o código de segurança', 'the security code'))
    return made
  }

  private async attendant(known?: string): Promise<string> {
    if (known) {
      try {
        await this.call('agents_get', { agent_id: known, fields: ['conversation_config.agent.first_message'] })
        return known
      } catch {
        // gone or unreachable: look for it by name below
      }
    }
    const found = pick(rows(await this.call('agents_list', {})).find((r) => pick(r, 'name') === ATTENDANT), 'agent_id', 'id')
    if (found) return found
    const made = pick(await this.call('agents_create', { name: ATTENDANT, prompt: `{{${PROMPT_VAR}}}`, first_message: `{{${FIRST_VAR}}}`, language: L('pt', 'en'), tags: ['tucano'] }), 'agent_id', 'id')
    if (!made) throw this.missing(L('o atendente', 'the attendant'))
    return made
  }

  // The three things the attendant can do during a call, as webhook tools that call Tucano back. The conversation
  // id is filled by the service itself (system variable), never by the model.
  private async tools(base: string, secretId: string): Promise<string[]> {
    const text = (description: string) => ({ type: 'string', description })
    const defs: { name: string; description: string; props: Record<string, unknown> }[] = [
      { name: 'consultar_wiki', description: L('Busca na base de conhecimento da equipe. Use antes de responder qualquer pergunta sobre produtos, preços, regras ou como algo funciona. Resuma com as suas palavras; não leia em voz alta.', "Searches the team's knowledge base. Use it before answering any question about products, prices, rules or how something works. Summarise in your own words; do not read it out."), props: { busca: text(L('O que procurar, em poucas palavras.', 'What to look for, in a few words.')) } },
      { name: 'ver_conversa', description: L('Mostra as mensagens recentes dessa pessoa no WhatsApp. Use quando ela se referir a algo que já foi conversado. Resuma com as suas palavras; não leia em voz alta.', "Shows this person's recent WhatsApp messages. Use it when they refer to something already discussed. Summarise in your own words; do not read it out."), props: {} },
      { name: 'anotar_recado', description: L('Anota, em uma frase clara, cada coisa que você prometeu ou que a pessoa pediu, para ser feita depois da ligação. Chame uma vez para cada uma. Resuma com as suas palavras; não leia em voz alta.', 'Writes down, in one clear sentence, each thing you promised or the person asked for, so it is done after the call. Call it once for each. Summarise in your own words; do not read it out.'), props: { texto: text(L('O que ficou combinado.', 'What was agreed.')) } }
    ]
    const existing = rows(await this.call('agents_list_tools', {}))
    const ids: string[] = []
    for (const d of defs) {
      const tool_config = {
        type: 'webhook',
        name: d.name,
        description: d.description,
        response_timeout_secs: 10,
        api_schema: {
          url: `${base.replace(/\/+$/, '')}/${d.name}`,
          method: 'POST',
          request_headers: { [HEADER]: { secret_id: secretId } },
          request_body_schema: { type: 'object', required: Object.keys(d.props), properties: { conversation_id: { type: 'string', dynamic_variable: 'system__conversation_id' }, ...d.props } }
        }
      }
      const found = pick(existing.find((r) => nameOf(r) === d.name), 'tool_id', 'id')
      if (found) {
        await this.call('agents_update_tool', { tool_id: found, body: { tool_config } })
        ids.push(found)
        continue
      }
      const made = pick(await this.call('agents_create_tool', { body: { tool_config } }), 'tool_id', 'id')
      if (!made) throw this.missing(L('a ferramenta do atendente', "the attendant's tool"))
      ids.push(made)
    }
    return ids
  }

  // Lets Tucano's answer at the start of a call replace the prompt, first sentence, language and voice, and says where to ask.
  private async overrides(agentId: string, startUrl: string, secretId: string): Promise<void> {
    const overrides = {
      enable_conversation_initiation_client_data_from_webhook: true,
      conversation_config_override: { agent: { prompt: { prompt: true, tool_ids: true }, first_message: true, language: true }, tts: { voice_id: true }, conversation: { max_duration_seconds: true } }
    }
    const webhook = { url: startUrl, request_headers: { [HEADER]: { secret_id: secretId } } }
    try {
      // Per attendant, so nothing else in the account is touched.
      await this.call('agents_update_client_overrides', { agent_id: agentId, overrides, workspace_overrides: { conversation_initiation_client_data_webhook: webhook } })
      return
    } catch {
      // Not accepted: the account-wide setting is the other place, which is shared, so it is never taken over from someone else.
    }
    await this.call('agents_update_client_overrides', { agent_id: agentId, overrides })
    const settings = rec(await this.call('agents_get_settings', {}))
    const hook = rec(settings?.['conversation_initiation_client_data_webhook']) ?? rec(rec(settings?.['settings'])?.['conversation_initiation_client_data_webhook'])
    const address = hook?.['url']
    // Written only when the settings were read and the address is empty or already ours. A shape that can't be read
    // counts as "not ours": the account-wide setting is never overwritten blind.
    const current = typeof address === 'string' ? address.trim() : undefined
    if (current === undefined || (current !== '' && current !== startUrl))
      throw new UserError(L('O ElevenLabs já tem outro endereço configurado para o início das conversas, e eu não mexo no que não fui eu que pus. Tire esse endereço nas configurações de agentes do ElevenLabs e tente de novo.', 'ElevenLabs already has another address set for the start of conversations, and I don’t change what I didn’t set. Remove that address in ElevenLabs’ agent settings and try again.'))
    await this.call('agents_update_settings', { body: { conversation_initiation_client_data_webhook: webhook } })
  }

  // The number on the service's side, with the credentials Meta's SIP side uses both ways. Found by the number, or made.
  private async trunk(agentId: string, p: PrepareInput): Promise<string> {
    const credentials = { username: p.sipUser, password: p.sipPassword }
    const inbound_trunk_config = { media_encryption: 'required', credentials }
    const outbound_trunk_config = { address: META_SIP, transport: 'tls', media_encryption: 'required', credentials }
    const digits = (s: string): string => s.replace(/\D/g, '')
    const found = pick(
      rows(await this.call('agents_list_phone_numbers', {})).find((r) => (p.known?.phoneNumberId && pick(r, 'phone_number_id', 'id') === p.known.phoneNumberId) || digits(pick(r, 'phone_number')) === digits(p.number)),
      'phone_number_id',
      'id'
    )
    if (found) {
      await this.call('agents_update_phone_number', { phone_number_id: found, body: { agent_id: agentId, label: p.label, inbound_trunk_config, outbound_trunk_config } })
      return found
    }
    const made = pick(await this.call('agents_create_phone_number', { provider: 'sip_trunk', phone_number: p.number, label: p.label, agent_id: agentId, inbound_trunk_config, outbound_trunk_config }), 'phone_number_id', 'id')
    if (!made) throw this.missing(L('o número', 'the number'))
    return made
  }

  // Best effort: each inbound call carries its own limit (see startReply); this one is the ceiling for calls Tucano places,
  // and a refusal here must not undo a number that is otherwise ready.
  async update(state: ProviderState, p: { maxSeconds: number }): Promise<void> {
    await this.call('agents_update_conversation', { agent_id: state.agentId, max_duration_seconds: p.maxSeconds }).catch(() => undefined)
  }

  async teardown(state: ProviderState): Promise<void> {
    try {
      await this.call('agents_delete_phone_number', { phone_number_id: state.phoneNumberId })
    } catch (e) {
      if (!gone(e)) throw e // already removed is as good as removed
    }
  }

  async voices(q?: string): Promise<VoiceOption[]> {
    const search = q?.trim().slice(0, 100)
    return parseVoices(await this.call('creative_list_voices', search ? { search } : {}))
  }

  // ---------- one call ----------

  readStart(body: unknown): { conversationId: string; caller: string; called: string } | undefined {
    // Only the conversation's own id: another id in its place would send the tools and the follow-up to the wrong call.
    const raw = rec(body)?.['conversation_id']
    const conversationId = typeof raw === 'string' ? raw.trim() : ''
    if (!conversationId || conversationId.length > 200) return undefined
    return { conversationId, caller: pick(body, 'caller_id', 'from'), called: pick(body, 'called_number', 'to') }
  }

  startReply(p: { prompt: string; firstMessage: string; language: string; voiceId?: string; toolIds: string[]; variables: Record<string, string>; maxSeconds?: number }): unknown {
    return {
      type: 'conversation_initiation_client_data',
      conversation_config_override: {
        agent: { prompt: { prompt: p.prompt, ...(p.toolIds.length ? { tool_ids: p.toolIds } : {}) }, first_message: p.firstMessage, language: p.language },
        ...(p.voiceId ? { tts: { voice_id: p.voiceId } } : {}),
        ...(p.maxSeconds ? { conversation: { max_duration_seconds: p.maxSeconds } } : {})
      },
      dynamic_variables: p.variables
    }
  }

  // What a webhook tool sends: the conversation id (filled by the service) and what the model chose to say.
  readTool(body: unknown): { conversationId: string; args: Record<string, unknown> } | undefined {
    const r = rec(body)
    const conversationId = pick(r, 'conversation_id')
    if (!r || !conversationId || conversationId.length > 200) return undefined
    const args = { ...r }
    delete args['conversation_id']
    return { conversationId, args }
  }

  async result(conversationId: string): Promise<{ seconds: number; summary?: string; turns: CallTurn[] } | undefined> {
    return parseConversation(await this.call('agents_get_conversation', { conversation_id: conversationId }))
  }

  // There is no "call now" tool: a batch of one recipient is. The batch has no conversation yet, so it is asked a few
  // times for the one the call got; without it the call still happens, it just can't be followed.
  async dial(state: ProviderState, p: { to: string; variables: Record<string, string> }): Promise<{ conversationId?: string }> {
    const batch = await this.call('agents_submit_batch_call', {
      call_name: `Tucano ${new Date().toISOString().slice(0, 16)}`,
      agent_id: state.agentId,
      agent_phone_number_id: state.phoneNumberId,
      recipients: [{ phone_number: p.to, id: 'tucano', dynamic_variables: p.variables }]
    })
    const batchId = pick(batch, 'id', 'batch_id', 'batch_call_id')
    if (!batchId) return {}
    for (const wait of [2_000, 4_000, 4_000, 4_000]) {
      await sleep(wait)
      for (const key of ['batch_id', 'batch_call_id', 'id']) {
        let got: unknown
        try {
          got = await this.call('agents_get_batch_call', { [key]: batchId })
        } catch {
          continue // that name for the argument wasn't the one
        }
        const recipients = rec(got)?.['recipients']
        const conversationId = (Array.isArray(recipients) ? recipients : []).map((x) => pick(x, 'conversation_id')).find(Boolean)
        if (conversationId) return { conversationId }
        break
      }
    }
    return {}
  }
}
