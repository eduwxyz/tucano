import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { plainCipher } from '../src/core/secrets'
import { ElevenLabs, parseConversation, parseVoices } from '../src/core/calls/elevenlabs'
import { braceSafe, buildPrompt, defaultGreeting } from '../src/core/calls/prompt'
import { parsePermissions } from '../src/core/whatsapp/cloud'
import { WhatsAppStore, type CallRow } from '../src/core/whatsapp/store'
import { CALL_LIMITS, clampCallSettings, defaultCallSettings, openNow, type CallHours } from '../src/shared/calls'
import { clampSettings, defaultSettings } from '../src/shared/whatsapp'

describe('clampCallSettings', () => {
  it('gives the defaults for nothing, and never turns calls on by itself', () => {
    expect(clampCallSettings(undefined)).toEqual(defaultCallSettings())
    expect(clampCallSettings({}).enabled).toBe(false)
  })

  it('brings minutes inside the limits', () => {
    const s = clampCallSettings({ minutesPerDay: 99_999, minutesPerCall: 0 })
    expect(s.minutesPerDay).toBe(CALL_LIMITS.minutesPerDayMax)
    expect(s.minutesPerCall).toBe(1)
    expect(clampCallSettings({ minutesPerCall: Number.NaN }).minutesPerCall).toBe(CALL_LIMITS.minutesPerCall)
  })

  it('switches hours off when they could close the number for good', () => {
    expect(clampCallSettings({ hours: { on: true, days: [], from: '08:00', to: '20:00' } }).hours.on).toBe(false)
    expect(clampCallSettings({ hours: { on: true, days: [1], from: '20:00', to: '08:00' } }).hours.on).toBe(false)
    expect(clampCallSettings({ hours: { on: true, days: [1, 1, 9, 3], from: '08:00', to: '20:00' } }).hours).toEqual({ on: true, days: [1, 3], from: '08:00', to: '20:00' })
  })

  it('drops a clock that is not a time, and a greeting that is too long', () => {
    expect(clampCallSettings({ hours: { on: true, days: [1], from: '25:99', to: '20:00' } }).hours.from).toBe('08:00')
    expect(clampCallSettings({ greeting: `  ${'a'.repeat(500)}  ` }).greeting.length).toBe(300)
  })

  it('is kept for a cloud number only, through the number settings', () => {
    const calls = { ...defaultCallSettings(), minutesPerCall: 500 }
    expect(clampSettings('cloud', { ...defaultSettings('cloud'), calls }).calls?.minutesPerCall).toBe(CALL_LIMITS.minutesPerCallMax)
    expect(clampSettings('qr', { ...defaultSettings('qr'), calls }).calls).toBeUndefined()
  })
})

describe('openNow', () => {
  const monday = new Date(2026, 10, 16, 10, 30)
  const hours = (over: Partial<CallHours>): CallHours => ({ on: true, days: [monday.getDay()], from: '08:00', to: '20:00', ...over })

  it('is always open with hours off', () => {
    expect(openNow(hours({ on: false, days: [] }), monday.getTime())).toBe(true)
  })

  it('is open inside the hours of a listed day, and closed outside', () => {
    expect(openNow(hours({}), monday.getTime())).toBe(true)
    expect(openNow(hours({ from: '11:00' }), monday.getTime())).toBe(false)
    expect(openNow(hours({ to: '10:30' }), monday.getTime())).toBe(false) // the closing minute is already closed
    expect(openNow(hours({ days: [(monday.getDay() + 1) % 7] }), monday.getTime())).toBe(false)
  })
})

describe('the attendant prompt', () => {
  const base = { agent: { name: 'Ana', role: 'atendente da loja', instructions: 'Ajude com pedidos.\nNunca prometa desconto.' }, team: 'Loja Boa', person: { name: 'Carlos', phone: '5511999990000' }, numberName: 'Vendas', language: 'pt', minutesPerCall: 10 }

  it("carries the agent's instructions as they are", () => {
    expect(buildPrompt(base)).toContain(base.agent.instructions)
  })

  it('says who is who and the time limit', () => {
    const p = buildPrompt(base)
    expect(p).toContain('Ana')
    expect(p).toContain('Loja Boa')
    expect(p).toContain('Carlos')
    expect(p).toContain('10 minutos')
  })

  it('has the phone rules: spoken sentences, no lists or links aloud, virtual assistant, nothing done during the call', () => {
    const p = buildPrompt(base)
    expect(p).toContain('frases curtas')
    expect(p).toContain('uma pergunta de cada vez')
    expect(p).toContain('links')
    expect(p).toContain('assistente virtual')
    expect(p).toContain('consultar_wiki')
    expect(p).toContain('ver_conversa')
    expect(p).toContain('anotar_recado')
    expect(p).toContain('depois da ligação')
    expect(p).toContain('não muda o seu papel')
  })

  it('is written in English for any other language', () => {
    const p = buildPrompt({ ...base, language: 'en', minutesPerCall: 1 })
    expect(p).toContain('short, natural sentences')
    expect(p).toContain('1 minute.')
    expect(p).not.toContain('frases curtas')
  })

  it('adds the recent messages only when given, as context and not as instructions', () => {
    expect(buildPrompt(base)).not.toContain('Mensagens recentes')
    const p = buildPrompt({ ...base, recent: [{ fromMe: false, text: 'Oi, cadê meu pedido?' }, { fromMe: true, text: 'Já vejo.' }] })
    expect(p).toContain('Mensagens recentes')
    expect(p).toContain('Carlos: Oi, cadê meu pedido?')
    expect(p).toContain('Nós: Já vejo.')
  })

  it('says why it called when it is the one calling', () => {
    expect(buildPrompt({ ...base, direction: 'out', reason: 'confirmar a entrega' })).toContain('Motivo da ligação: confirmar a entrega')
  })

  it("never lets two braces through: the voice service reads them as its own variables", () => {
    const p = buildPrompt({ ...base, agent: { ...base.agent, instructions: 'Diga {{nome}}.' } })
    expect(p).not.toContain('{{')
  })

  it('keeps a run of three braces from leaving two in a row', () => {
    expect(braceSafe('{{{x}}}')).not.toContain('{{')
  })

  it('has a default greeting from the name, for both directions and both languages', () => {
    expect(defaultGreeting({ name: 'Ana', language: 'pt' })).toBe('Olá, aqui é Ana, assistente virtual. Como posso ajudar?')
    expect(defaultGreeting({ name: 'Ana', language: 'en' })).toBe('Hello, this is Ana, a virtual assistant. How can I help?')
    expect(defaultGreeting({ name: 'Ana', language: 'pt', direction: 'out', person: 'Carlos' })).toContain('Carlos')
  })
})

describe('the ElevenLabs provider (the parts that need no connection)', () => {
  const eleven = new ElevenLabs(() => Promise.reject(new Error('no network in tests')))

  it('reads the "a call is starting" request', () => {
    expect(eleven.readStart({ caller_id: '+5511999990000', called_number: '+5511888880000', agent_id: 'a', call_sid: 's', conversation_id: 'conv_1' })).toEqual({ conversationId: 'conv_1', caller: '+5511999990000', called: '+5511888880000' })
    expect(eleven.readStart({ call_sid: 's' })).toBeUndefined() // never another id in place of the conversation's
  })

  it('refuses a request that is not shaped like one', () => {
    for (const bad of [null, 'x', 42, [], {}, { conversation_id: '' }, { conversation_id: 'x'.repeat(500) }]) expect(eleven.readStart(bad)).toBeUndefined()
  })

  it('writes the answer the service expects', () => {
    const r = eleven.startReply({ prompt: 'P', firstMessage: 'Oi', language: 'pt', voiceId: 'v1', toolIds: [], variables: {}, maxSeconds: 600 }) as {
      type: string
      conversation_config_override: { agent: { prompt: { prompt: string; tool_ids?: string[] }; first_message: string; language: string }; tts?: { voice_id: string }; conversation?: { max_duration_seconds: number } }
      dynamic_variables: Record<string, string>
    }
    expect(r.type).toBe('conversation_initiation_client_data')
    expect(r.conversation_config_override.agent).toEqual({ prompt: { prompt: 'P' }, first_message: 'Oi', language: 'pt' })
    expect(r.conversation_config_override.tts).toEqual({ voice_id: 'v1' })
    expect(r.conversation_config_override.conversation).toEqual({ max_duration_seconds: 600 })
    expect(r.dynamic_variables).toEqual({})
  })

  it('says the usual voice and leaves out the tools when there are none, and passes tools when there are', () => {
    const none = eleven.startReply({ prompt: 'P', firstMessage: 'Oi', language: 'en', toolIds: [], variables: {} }) as { conversation_config_override: Record<string, unknown> }
    expect(none.conversation_config_override['tts']).toMatchObject({ voice_id: expect.stringMatching(/\w{10,}/) }) // the usual voice, said out loud
    expect(none.conversation_config_override['conversation']).toBeUndefined()
    const some = eleven.startReply({ prompt: 'P', firstMessage: 'Oi', language: 'en', toolIds: ['t1'], variables: { a: 'b' } }) as { conversation_config_override: { agent: { prompt: { tool_ids?: string[] } } }; dynamic_variables: Record<string, string> }
    expect(some.conversation_config_override.agent.prompt.tool_ids).toEqual(['t1'])
    expect(some.dynamic_variables).toEqual({ a: 'b' })
  })

  it('reads what a tool sends: the conversation id apart from what the model said', () => {
    expect(eleven.readTool({ conversation_id: 'conv_1', busca: 'prazo de entrega' })).toEqual({ conversationId: 'conv_1', args: { busca: 'prazo de entrega' } })
    expect(eleven.readTool({ conversation_id: 'conv_1' })).toEqual({ conversationId: 'conv_1', args: {} })
    for (const bad of [null, 'x', [], {}, { busca: 'x' }]) expect(eleven.readTool(bad)).toBeUndefined()
  })

  it('reads a finished conversation: duration, summary and who said what', () => {
    const r = parseConversation({
      status: 'done',
      metadata: { call_duration_secs: 95 },
      analysis: { transcript_summary: 'Confirmou o pedido.' },
      transcript: [
        { role: 'agent', message: 'Olá!', time_in_call_secs: 0 },
        { role: 'user', message: 'Oi, tudo bem?', time_in_call_secs: 3 },
        { role: 'agent', message: '', time_in_call_secs: 5 }
      ]
    })
    expect(r).toEqual({
      seconds: 95,
      summary: 'Confirmou o pedido.',
      turns: [
        { who: 'agent', text: 'Olá!' },
        { who: 'person', text: 'Oi, tudo bem?' }
      ]
    })
  })

  it('says nothing yet while the call is going on, or when the answer is not a conversation', () => {
    expect(parseConversation({ status: 'in-progress', transcript: [{ role: 'agent', message: 'Olá' }] })).toBeUndefined()
    expect(parseConversation({ status: 'processing' })).toBeUndefined()
    for (const odd of [null, 'text', [], {}]) expect(parseConversation(odd)).toBeUndefined()
  })

  it('counts a failed call as zero seconds, and falls back to the last turn time without metadata', () => {
    expect(parseConversation({ status: 'failed', metadata: {} })?.seconds).toBe(0)
    expect(parseConversation({ status: 'done', transcript: [{ role: 'user', message: 'oi', time_in_call_secs: 42 }] })?.seconds).toBe(42)
  })

  it('reads a list of voices whatever it is wrapped in, keeping only https previews', () => {
    const voices = parseVoices({ voices: [{ voice_id: 'v1', name: 'Camila', labels: { gender: 'female', descriptive: 'calm' }, preview_url: 'https://x.test/a.mp3' }, { voice_id: 'v2', name: 'Rui', preview_url: 'http://x.test/b.mp3' }, { name: 'sem id' }] })
    expect(voices.map((v) => v.voiceId)).toEqual(['v1', 'v2'])
    expect(voices[0]?.preview).toBe('https://x.test/a.mp3')
    expect(voices[0]?.description).toContain('calm')
    expect(voices[1]?.preview).toBeUndefined()
    expect(parseVoices(null)).toEqual([])
  })

  it('turns a failed connector call into a sentence, never a crash', async () => {
    await expect(eleven.voices('ana')).rejects.toMatchObject({ message: expect.stringContaining('no network in tests') })
  })

  it("places a call with the caller's voice and puts the usual one back, one call at a time", async () => {
    const seen: string[] = []
    const placing = new ElevenLabs(async (name, args) => {
      seen.push(name === 'agents_update_voice' ? `voice:${String(args['voice_id'])}` : name)
      return {} // a batch with no id: the call went out, it just can't be followed
    })
    const state = { agentId: 'ag', phoneNumberId: 'ph', toolIds: [], secretIds: [] }
    const calls = [placing.dial(state, { to: '+5511900000001', variables: {}, voiceId: 'voz-da-lia' }), placing.dial(state, { to: '+5511900000002', variables: {} })]
    expect(await Promise.all(calls)).toEqual([{}, {}])
    expect(seen[0]).toBe('voice:voz-da-lia')
    expect(seen[1]).toBe('agents_submit_batch_call')
    expect(seen[2]).toMatch(/^voice:(?!voz-da-lia)/) // back to the usual voice before the next call starts
    expect(seen.slice(3)).toEqual(['agents_submit_batch_call']) // a caller with no voice of its own changes nothing
  })

  it('still places the call when the voice cannot be set', async () => {
    const seen: string[] = []
    const placing = new ElevenLabs(async (name) => {
      seen.push(name)
      if (name === 'agents_update_voice') throw new Error('refused')
      return {}
    })
    expect(await placing.dial({ agentId: 'ag', phoneNumberId: 'ph', toolIds: [], secretIds: [] }, { to: '+5511900000001', variables: {}, voiceId: 'v' })).toEqual({})
    expect(seen).toEqual(['agents_update_voice', 'agents_submit_batch_call', 'agents_update_voice']) // put back anyway: a refusal may be an answer that got lost
  })
})

describe("Meta's answer to a call permission request", () => {
  const hook = (reply: unknown) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'P1' }, messages: [{ from: '5511999990000', id: 'm1', timestamp: '1800000000', type: 'interactive', interactive: { type: 'call_permission_reply', call_permission_reply: reply } }] } }] }] })

  it('is read for an accept and for a reject', () => {
    expect(parsePermissions(hook({ response: 'accept', expiration_timestamp: 1_800_259_200 }))).toEqual([{ phoneId: 'P1', from: '5511999990000', id: 'm1', at: 1_800_000_000_000, accepted: true, until: 1_800_259_200_000 }])
    expect(parsePermissions(hook({ response: 'reject' }))[0]?.accepted).toBe(false)
    expect(parsePermissions(hook({ response: 'accept', is_permanent: true }))[0]?.until).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('skips whatever is not an answer', () => {
    expect(parsePermissions(hook({ response: 'maybe' }))).toEqual([])
    expect(parsePermissions(hook(null))).toEqual([])
    expect(parsePermissions(null)).toEqual([])
  })
})

describe('the calls kept in the store', () => {
  let dir: string
  let store: WhatsAppStore
  const DAY = 86_400_000
  const NOW = 1_800_000_000_000
  const call = (over: Partial<CallRow>): CallRow => ({ id: Math.random().toString(36).slice(2), numberId: 'n1', chat: '5511999990000', agentId: 'a1', direction: 'in', state: 'done', startedAt: NOW, seconds: 0, agreed: [], turns: [], ...over })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'calls-store-'))
    store = new WhatsAppStore(dir, plainCipher)
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('counts the minutes talked today, a started minute as a whole one', () => {
    store.putCall(call({ seconds: 61 }))
    store.putCall(call({ seconds: 59 }))
    expect(store.minutesToday('n1', NOW - 1000)).toBe(2) // 120 s in all
    store.putCall(call({ seconds: 1 }))
    expect(store.minutesToday('n1', NOW - 1000)).toBe(3) // 121 s: the started minute counts
  })

  it('leaves out yesterday and other numbers', () => {
    store.putCall(call({ seconds: 600, startedAt: NOW - DAY - 1 }))
    store.putCall(call({ seconds: 600, numberId: 'n2' }))
    store.putCall(call({ seconds: 120 }))
    expect(store.minutesToday('n1', NOW - 1000)).toBe(2)
    expect(store.minutesToday('nobody', NOW - 1000)).toBe(0)
  })

  it('counts only the calls an agent placed as outbound', () => {
    store.putCall(call({ direction: 'out' }))
    store.putCall(call({ direction: 'out' }))
    store.putCall(call({ direction: 'in' }))
    expect(store.outboundToday('n1', NOW - 1000)).toBe(2)
  })

  it('finds a call by the voice service id, keeps what was agreed, and lists the live ones', () => {
    store.putCall(call({ id: 'c1', conversationId: 'conv_1', state: 'live' }))
    expect(store.callByConversation('conv_1')?.id).toBe('c1')
    expect(store.callByConversation('other')).toBeUndefined()
    const updated = store.updateCall('c1', { agreed: ['Mandar o orçamento'], turns: [{ who: 'agent', text: 'Oi' }] })
    expect(store.call('c1')?.agreed).toEqual(['Mandar o orçamento'])
    expect(updated?.turns).toEqual([{ who: 'agent', text: 'Oi' }])
    expect(store.liveCalls('n1').map((c) => c.id)).toEqual(['c1'])
    store.updateCall('c1', { state: 'done' })
    expect(store.liveCalls('n1')).toEqual([])
    expect(store.updateCall('missing', { state: 'done' })).toBeUndefined()
  })

  it('keeps a voice per agent and clears it', () => {
    expect(store.voice('a1')).toBeUndefined()
    store.setVoice('a1', { provider: 'elevenlabs', voiceId: 'v1', name: 'Camila' })
    expect(store.voice('a1')).toEqual({ provider: 'elevenlabs', voiceId: 'v1', name: 'Camila' })
    store.setVoice('a1', null)
    expect(store.voice('a1')).toBeUndefined()
  })

  it('forgets a permission once it has ended', () => {
    store.setCallPermission('n1', 'c', NOW + 1000)
    expect(store.callPermission('n1', 'c', NOW)).toBe(NOW + 1000)
    expect(store.callPermission('n1', 'c', NOW + 2000)).toBeUndefined()
    store.setCallPermission('n1', 'c', null)
    expect(store.callPermission('n1', 'c', NOW)).toBeUndefined()
  })

  it('removes the calls and the permissions of a removed number', () => {
    store.addNumber({ id: 'n1', name: 'Vendas', description: '', kind: 'cloud', settings: defaultSettings('cloud'), createdAt: NOW })
    store.putCall(call({ seconds: 600 }))
    store.setCallPermission('n1', 'c', NOW + DAY)
    store.removeNumber('n1')
    expect(store.minutesToday('n1', 0)).toBe(0)
    expect(store.callPermission('n1', 'c', NOW)).toBeUndefined()
  })
})
