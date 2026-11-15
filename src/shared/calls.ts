// Calls on a WhatsApp number of the official API, answered by one of the team's agents with a
// voice service's voice. The agent is defined once, here: at the start of every call the voice
// service asks Tucano who answers and gets the agent's goal, behaviour, first sentence and voice.
// What is shared by the core, the window and the tests lives in this file.

// The voice services Tucano knows. One today; another one is one more piece of code behind the
// same boundary (src/core/calls/provider.ts), never a setting.
export type VoiceProviderId = 'elevenlabs'

export const VOICE_PROVIDERS: Record<VoiceProviderId, { name: string; connector: string }> = {
  // `connector`: how the connector of this service is recognised among the connected ones (its address).
  elevenlabs: { name: 'ElevenLabs', connector: 'api.elevenlabs.io' }
}

export interface CallHours {
  on: boolean
  days: number[] // 0 Sunday … 6 Saturday
  from: string // "08:00"
  to: string // "20:00"
  tz?: string // the time zone those hours are in ("America/Sao_Paulo"): the window's, since a server's own is often UTC
}

// How one number takes calls. Kept with the number's other settings.
export interface CallSettings {
  enabled: boolean
  provider: VoiceProviderId
  agentId?: string // who answers: one agent per number
  greeting: string // the first sentence; empty: the one Tucano writes from the agent's name
  hours: CallHours
  outbound: boolean // agents may call people (always behind an approval, after the person allowed calls)
  minutesPerDay: number
  minutesPerCall: number
}

export const CALL_LIMITS = { minutesPerDay: 120, minutesPerDayMax: 1_440, minutesPerCall: 10, minutesPerCallMax: 30, outboundPerDay: 20 }
export const GREETING_MAX = 300

export function defaultCallSettings(): CallSettings {
  return { enabled: false, provider: 'elevenlabs', greeting: '', hours: { on: false, days: [1, 2, 3, 4, 5], from: '08:00', to: '20:00' }, outbound: false, minutesPerDay: CALL_LIMITS.minutesPerDay, minutesPerCall: CALL_LIMITS.minutesPerCall }
}

// A time zone the system knows, or none.
export function validZone(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v || v.length > 60) return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v })
    return v
  } catch {
    return undefined
  }
}

const clock = (v: unknown, fallback: string): string => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : fallback)
const whole = (v: unknown, fallback: number, min: number, max: number): number => Math.min(max, Math.max(min, typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback))

// What the screen (or an old row) asks for, brought inside what's allowed: never an error.
export function clampCallSettings(s: Partial<CallSettings> | undefined): CallSettings {
  const d = defaultCallSettings()
  const h: Partial<CallHours> = s?.hours && typeof s.hours === 'object' ? s.hours : {}
  const days = Array.isArray(h.days) ? [...new Set(h.days.filter((x): x is number => Number.isInteger(x) && x >= 0 && x <= 6))].sort() : d.hours.days
  const from = clock(h.from, d.hours.from)
  const to = clock(h.to, d.hours.to)
  const tz = validZone(h.tz)
  return {
    enabled: s?.enabled === true,
    provider: typeof s?.provider === 'string' && Object.hasOwn(VOICE_PROVIDERS, s.provider) ? s.provider : d.provider,
    ...(typeof s?.agentId === 'string' && s.agentId && s.agentId.length <= 100 ? { agentId: s.agentId } : {}),
    greeting: typeof s?.greeting === 'string' ? s.greeting.trim().slice(0, GREETING_MAX) : '',
    // Hours that end before they start, or no day at all, mean "always": the switch goes off rather than closing the number for good.
    hours: { on: h.on === true && days.length > 0 && from < to, days: days.length ? days : d.hours.days, from, to, ...(tz ? { tz } : {}) },
    outbound: s?.outbound === true,
    minutesPerDay: whole(s?.minutesPerDay, d.minutesPerDay, 1, CALL_LIMITS.minutesPerDayMax),
    minutesPerCall: whole(s?.minutesPerCall, d.minutesPerCall, 1, CALL_LIMITS.minutesPerCallMax)
  }
}

// Whether a call that starts at `now` is inside the number's hours, read in the hours' own time zone
// (this computer's when none was given).
export function openNow(h: CallHours, now: number): boolean {
  if (!h.on) return true
  const zone = validZone(h.tz)
  const parts = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(zone ? { timeZone: zone } : {}) }).formatToParts(new Date(now))
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  const hm = `${get('hour')}:${get('minute')}`
  return h.days.includes(day) && hm >= h.from && hm < h.to
}

// ---------- a call, as it is kept and shown ----------

export type CallState = 'live' | 'done' | 'missed' | 'failed'

export interface CallTurn {
  who: 'agent' | 'person'
  text: string
}

// What a conversation shows of a call: the line while it is on, the card when it is over.
export interface CallCard {
  id: string
  numberId: string
  numberName: string
  chat: string // the conversation it belongs to (the person's)
  person: string // their name, or their number
  direction: 'in' | 'out'
  state: CallState
  startedAt: number
  seconds?: number
  summary?: string
  agreed?: string[] // what the agent wrote down as agreed during the call
  turns?: CallTurn[]
  note?: string // why it has no details (the voice service wasn't reachable afterwards)
}

export const TURNS_MAX = 400
export const TURN_TEXT_MAX = 2_000

// ---------- what the screen reads ----------

export interface VoiceChoice {
  provider: VoiceProviderId
  voiceId: string
  name: string
}

export interface VoiceOption {
  voiceId: string
  name: string
  description?: string // "feminina · calma"
  preview?: string // an https address with a sample to play
}

// A number's calls, for its screen.
export interface CallsState {
  available: boolean // an official-API number on a server with https
  why?: string // what is missing, in words
  provider?: { id: VoiceProviderId; name: string; connected: boolean } // the voice service in use, and whether its connector is connected now
  ready: boolean // prepared at the voice service and at Meta
  settings: CallSettings
  usedToday: number // minutes
  problem?: string // the last thing that went wrong, in words
  step?: CallSetupStep // while calls are being turned on: the step it is at
}

// The steps of turning calls on, as the screen shows them one by one.
export type CallSetupStep = 'connector' | 'attendant' | 'number' | 'done'
