// "Enviar feedback" and the small surveys in the sidebar's foot, through tucano.sh (site/worker.js,
// which alone holds the database's key). What goes: the person's text, the window's picture when they
// leave it checked, the app's version, the system and the language. A survey's answer goes with the
// install's id: a random id made once on this computer, with no name, email or account behind it, so
// answering again replaces the answer instead of counting twice. TUCANO_FEEDBACK_URL points at another
// address, or `off` turns all of it off (no survey is even asked for).
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { L, type Lang } from '../shared/lang'
import type { SurveyView } from '../shared/rpc'
import type { Os } from '../shared/types'

export type { SurveyView }

export const FEEDBACK_URL = 'https://tucano.sh/api'
export const FEEDBACK_KINDS = ['bug', 'idea', 'other'] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]
export const MAX_FEEDBACK = 5_000 // characters of text
export const MAX_FEEDBACK_IMAGE = 3 * 1024 * 1024 // bytes of picture, what the bucket takes
export const SURVEY_EVERY_MS = 6 * 60 * 60 * 1000 // how long a survey (or none) is trusted before asking again

// The address from the environment: the default, another one, or none. With fake engines (tests, the
// screens' script) none unless one is set: nothing reaches tucano.sh from a test.
export function feedbackUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env['TUCANO_FEEDBACK_URL']?.trim()
  if (v === 'off' || v === '0') return undefined
  if (!v && env['TUCANO_FAKE_ENGINES'] === '1') return undefined
  return (v || FEEDBACK_URL).replace(/\/+$/, '')
}

// ---------- this install ----------

// One per computer (the desktop's data folder, every workspace in it; a server's own folder).
// firstVersion: the version it started on; an install from before this file existed says 0.0.0,
// so a question about what changed reaches those who saw the old way.
export interface Install {
  id: string
  firstVersion: string
  surveysDone: string[] // the surveys answered or turned down here: never shown again
}

const INSTALL_FILE = 'install.json'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const VERSION = /^\d+\.\d+\.\d+$/

function read(dir: string): Install | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, INSTALL_FILE), 'utf8')) as Partial<Install>
    if (typeof raw.id !== 'string' || !UUID.test(raw.id)) return undefined
    return {
      id: raw.id,
      firstVersion: typeof raw.firstVersion === 'string' && VERSION.test(raw.firstVersion) ? raw.firstVersion : '0.0.0',
      surveysDone: Array.isArray(raw.surveysDone) ? raw.surveysDone.filter((s): s is string => typeof s === 'string').slice(-200) : []
    }
  } catch {
    return undefined
  }
}

function write(dir: string, install: Install): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, INSTALL_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(install, null, 1))
  renameSync(tmp, file)
}

// The install as it is, made the first time. fresh: nothing was here before (a new install), so it
// starts on this version; otherwise it's one from before, and starts on 0.0.0.
export function readInstall(dir: string, version: string, fresh: boolean): Install {
  const found = read(dir)
  if (found) return found
  const made: Install = { id: randomUUID(), firstVersion: fresh && VERSION.test(version) ? version : '0.0.0', surveysDone: [] }
  try {
    write(dir, made)
  } catch (e) {
    console.error('[feedback] install:', e instanceof Error ? e.message : e)
  }
  return made
}

export function markSurveyDone(dir: string, survey: string, version: string): void {
  const install = readInstall(dir, version, false)
  if (install.surveysDone.includes(survey)) return
  write(dir, { ...install, surveysDone: [...install.surveysDone, survey].slice(-200) })
}

// ---------- the client ----------

// What the worker sent, checked: anything else is no survey.
export function surveyOf(raw: unknown): SurveyView | null {
  const s = (raw as { survey?: unknown } | null)?.survey as Partial<SurveyView> | null | undefined
  if (!s || typeof s !== 'object') return null
  if (typeof s.id !== 'string' || !/^[a-z0-9-]{1,60}$/.test(s.id) || typeof s.question !== 'string' || !s.question.trim()) return null
  if (!Array.isArray(s.options)) return null
  const options = s.options
    .filter((o): o is { id: string; label: string } => !!o && typeof o.id === 'string' && typeof o.label === 'string' && !!o.id && !!o.label.trim())
    .slice(0, 6)
    .map((o) => ({ id: o.id.slice(0, 60), label: o.label.slice(0, 80) }))
  if (options.length < 2) return null
  const followUp = typeof s.followUp === 'string' && s.followUp.trim() ? s.followUp.slice(0, 200) : undefined
  return { id: s.id, question: s.question.slice(0, 200), options, ...(followUp ? { followUp } : {}) }
}

// The picture: base64 of a PNG or a JPEG (by its first bytes), within the bucket's size.
export function imageError(base64: string): string | undefined {
  const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
  if (bytes > MAX_FEEDBACK_IMAGE) return L('A imagem da tela é grande demais. Desmarque e envie só o texto.', 'The screen image is too big. Uncheck it and send just the text.')
  const head = Buffer.from(base64.slice(0, 16), 'base64')
  const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
  const jpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
  return png || jpg ? undefined : L('A imagem da tela não deu certo. Desmarque e envie só o texto.', "The screen image didn't work. Uncheck it and send just the text.")
}

export class Feedback {
  private cached: { at: number; lang: Lang; survey: SurveyView | null } | undefined

  constructor(
    private deps: {
      url: string | undefined // undefined: off
      dir: string // where install.json is
      version: string
      fresh: boolean // a new install (see readInstall)
      os: Os
      fetch?: typeof fetch
      now?: () => number
    }
  ) {}

  get on(): boolean {
    return !!this.deps.url
  }

  install(): Install {
    return readInstall(this.deps.dir, this.deps.version, this.deps.fresh)
  }

  private post(path: string, body: unknown, ms: number): Promise<Response> {
    return (this.deps.fetch ?? fetch)(`${this.deps.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms)
    })
  }

  // Throws, in the person's words, when it didn't go: the dialog says so and keeps the text.
  async send(p: { kind: FeedbackKind; message: string; image?: string; lang: Lang }): Promise<void> {
    if (!this.deps.url) throw new Error(L('O envio de feedback está desligado neste Tucano.', 'Sending feedback is turned off in this Tucano.'))
    const message = p.message.trim()
    if (!message) throw new Error(L('Escreva o que aconteceu.', 'Write what happened.'))
    if (message.length > MAX_FEEDBACK) throw new Error(L(`Texto grande demais (até ${MAX_FEEDBACK.toLocaleString('pt-BR')} caracteres).`, `Text too long (up to ${MAX_FEEDBACK.toLocaleString('en-US')} characters).`))
    const image = p.image?.replace(/^data:image\/(png|jpeg);base64,/, '')
    if (image) {
      const bad = imageError(image)
      if (bad) throw new Error(bad)
    }
    let r: Response
    try {
      r = await this.post('/feedback', { kind: p.kind, message, ...(image ? { image } : {}), version: this.deps.version, os: this.deps.os, lang: p.lang }, 60_000)
    } catch {
      throw new Error(L('Não consegui enviar agora. Confira a internet e tente de novo.', "I couldn't send it right now. Check the internet and try again."))
    }
    if (r.ok) return
    // The worker's error is a code for logs; the person reads ours, in their language.
    if (r.status === 429) throw new Error(L('Muitos envios seguidos. Espere um minuto e tente de novo.', 'Too many in a row. Wait a minute and try again.'))
    if (r.status === 413) throw new Error(L('Ficou grande demais. Desmarque a imagem e envie só o texto.', 'It got too big. Uncheck the image and send just the text.'))
    throw new Error(L('Não consegui enviar agora. Tente de novo em um minuto.', "I couldn't send it right now. Try again in a minute."))
  }

  // The survey this install should see now, or none: off, already answered or turned down, the worker
  // unreachable. Asked again at most every few hours (or when the language changes).
  async survey(p: { lang: Lang; force?: boolean }): Promise<SurveyView | null> {
    if (!this.deps.url) return null
    const now = (this.deps.now ?? Date.now)()
    const install = this.install()
    const done = (s: SurveyView | null): SurveyView | null => (s && install.surveysDone.includes(s.id) ? null : s)
    if (!p.force && this.cached && this.cached.lang === p.lang && now - this.cached.at < SURVEY_EVERY_MS) return done(this.cached.survey)
    const q = new URLSearchParams({ version: this.deps.version, first: install.firstVersion, os: this.deps.os, lang: p.lang })
    let survey: SurveyView | null = null
    try {
      const r = await (this.deps.fetch ?? fetch)(`${this.deps.url}/surveys?${q}`, { signal: AbortSignal.timeout(15_000) })
      if (r.ok) survey = surveyOf(await r.json())
    } catch {
      // No survey this time; the next ask tries again.
    }
    this.cached = { at: now, lang: p.lang, survey }
    return done(survey)
  }

  // A choice is kept the moment it's clicked; the comment, when written, completes the same answer.
  // dismiss: "Não quero responder", nothing goes, and it never shows again.
  async answer(p: { survey: string; choice?: string; comment?: string; dismiss?: boolean; lang: Lang }): Promise<void> {
    const markDone = (): void => {
      try {
        markSurveyDone(this.deps.dir, p.survey, this.deps.version)
      } catch (e) {
        console.error('[feedback] survey:', e instanceof Error ? e.message : e)
      }
    }
    if (p.dismiss || !p.choice) return markDone()
    if (!this.deps.url) return
    const install = this.install()
    const comment = p.comment?.trim().slice(0, 2_000)
    let r: Response
    try {
      r = await this.post('/surveys/answer', { survey: p.survey, install: install.id, choice: p.choice, ...(comment ? { comment } : {}), version: this.deps.version, first: install.firstVersion, os: this.deps.os, lang: p.lang }, 15_000)
    } catch {
      throw new Error(L('Não consegui enviar a resposta. Tente de novo.', "I couldn't send the answer. Try again."))
    }
    if (!r.ok) throw new Error(L('Não consegui enviar a resposta. Tente de novo.', "I couldn't send the answer. Try again."))
    markDone()
  }
}
