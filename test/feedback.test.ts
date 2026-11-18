// "Enviar feedback" and the surveys, against a fake tucano.sh: what goes, what's refused before it goes,
// and the install's id and first version kept once per computer (src/core/feedback.ts).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Feedback, feedbackUrl, readInstall, surveyOf } from '../src/core/feedback'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64')
const SURVEY = { id: 'ui-nova', question: 'A barra lateral mudou. Prefere a nova ou a de antes?', options: [{ id: 'new', label: 'A nova' }, { id: 'old', label: 'A de antes' }, { id: 'any', label: 'Tanto faz' }], followUp: 'O que faz falta?' }

let dir: string
let calls: { url: string; init?: RequestInit }[]
let reply: () => Response
let now: number
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tucano-feedback-'))
  calls = []
  now = 1_000_000
  reply = () => Response.json({ ok: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const fetcher = (async (url: string | URL, init?: RequestInit) => {
  calls.push({ url: String(url), init })
  return reply()
}) as typeof fetch
const client = (o: { url?: string | null; fresh?: boolean } = {}): Feedback =>
  new Feedback({ url: o.url === null ? undefined : (o.url ?? 'https://x.test/api'), dir, version: '0.2.37', fresh: o.fresh ?? false, os: 'mac', fetch: fetcher, now: () => now })
const body = (i = 0): Record<string, unknown> => JSON.parse(String(calls[i]!.init!.body)) as Record<string, unknown>

describe('the address', () => {
  it('tucano.sh by default, another one, or off; never from a test with fake engines unless one is set', () => {
    expect(feedbackUrl({})).toBe('https://tucano.sh/api')
    expect(feedbackUrl({ TUCANO_FEEDBACK_URL: 'http://127.0.0.1:9/api/' })).toBe('http://127.0.0.1:9/api')
    expect(feedbackUrl({ TUCANO_FEEDBACK_URL: 'off' })).toBeUndefined()
    expect(feedbackUrl({ TUCANO_FEEDBACK_URL: '0' })).toBeUndefined()
    expect(feedbackUrl({ TUCANO_FAKE_ENGINES: '1' })).toBeUndefined()
    expect(feedbackUrl({ TUCANO_FAKE_ENGINES: '1', TUCANO_FEEDBACK_URL: 'http://stub/api' })).toBe('http://stub/api')
  })
})

describe('the install', () => {
  it('made once: a new install starts on its version, one from before on 0.0.0; the id stays', () => {
    const fresh = readInstall(dir, '0.2.37', true)
    expect(fresh.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(fresh.firstVersion).toBe('0.2.37')
    expect(readInstall(dir, '0.3.0', false)).toEqual(fresh)
    const old = mkdtempSync(join(tmpdir(), 'tucano-feedback-old-'))
    try {
      expect(readInstall(old, '0.2.37', false).firstVersion).toBe('0.0.0')
    } finally {
      rmSync(old, { recursive: true, force: true })
    }
  })

  it('a broken file is made again', () => {
    writeFileSync(join(dir, 'install.json'), '{nope')
    expect(readInstall(dir, '0.2.37', false).id).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('sending feedback', () => {
  it('the text, the picture, the version, the system and the language; nothing else', async () => {
    await client().send({ kind: 'bug', message: '  A Lia não achou a agenda.  ', image: PNG, lang: 'pt' })
    expect(calls[0]!.url).toBe('https://x.test/api/feedback')
    expect(calls[0]!.init!.method).toBe('POST')
    expect(body()).toEqual({ kind: 'bug', message: 'A Lia não achou a agenda.', image: PNG, version: '0.2.37', os: 'mac', lang: 'pt' })
  })

  it('without a picture, the field is left out; a data: prefix is dropped', async () => {
    await client().send({ kind: 'idea', message: 'oi', lang: 'en' })
    expect('image' in body()).toBe(false)
    await client().send({ kind: 'idea', message: 'oi', image: `data:image/png;base64,${PNG}`, lang: 'en' })
    expect(body(1).image).toBe(PNG)
  })

  it('refused before it goes: empty, too long, not a picture, too big', async () => {
    const c = client()
    await expect(c.send({ kind: 'bug', message: '   ', lang: 'pt' })).rejects.toThrow(/Escreva/)
    await expect(c.send({ kind: 'bug', message: 'x'.repeat(5001), lang: 'pt' })).rejects.toThrow(/grande demais/)
    await expect(c.send({ kind: 'bug', message: 'x', image: Buffer.from('<svg/>').toString('base64'), lang: 'pt' })).rejects.toThrow(/imagem da tela/)
    const big = Buffer.alloc(3 * 1024 * 1024 + 10)
    big.set([0x89, 0x50, 0x4e, 0x47])
    await expect(c.send({ kind: 'bug', message: 'x', image: big.toString('base64'), lang: 'pt' })).rejects.toThrow(/grande demais/)
    expect(calls).toHaveLength(0)
  })

  it('our own line for a refusal (never the worker’s code), or when it is down; off says so', async () => {
    reply = () => Response.json({ error: 'too many' }, { status: 429 })
    await expect(client().send({ kind: 'bug', message: 'x', lang: 'pt' })).rejects.toThrow('Muitos envios seguidos')
    reply = () => Response.json({ error: 'save' }, { status: 502 })
    await expect(client().send({ kind: 'bug', message: 'x', lang: 'pt' })).rejects.toThrow(/^Não consegui enviar agora/)
    reply = () => {
      throw new Error('ECONNREFUSED')
    }
    await expect(client().send({ kind: 'bug', message: 'x', lang: 'pt' })).rejects.toThrow(/Confira a internet/)
    await expect(client({ url: null }).send({ kind: 'bug', message: 'x', lang: 'pt' })).rejects.toThrow(/desligado/)
  })
})

describe('surveys', () => {
  it('asked with the version, the first version, the system and the language; kept for hours', async () => {
    readInstall(dir, '0.2.37', false)
    reply = () => Response.json({ survey: SURVEY })
    const c = client()
    expect(await c.survey({ lang: 'pt' })).toEqual(SURVEY)
    const q = new URL(calls[0]!.url)
    expect(q.pathname).toBe('/api/surveys')
    expect(Object.fromEntries(q.searchParams)).toEqual({ version: '0.2.37', first: '0.0.0', os: 'mac', lang: 'pt' })
    await c.survey({ lang: 'pt' })
    expect(calls).toHaveLength(1)
    now += 7 * 60 * 60 * 1000
    await c.survey({ lang: 'pt' })
    expect(calls).toHaveLength(2)
    await c.survey({ lang: 'en' }) // another language: asked again
    expect(calls).toHaveLength(3)
  })

  it('a choice goes with the install id the moment it is made; the comment completes it; then it never shows again', async () => {
    reply = () => Response.json({ survey: SURVEY })
    const c = client()
    await c.survey({ lang: 'pt' })
    reply = () => Response.json({ ok: true })
    await c.answer({ survey: 'ui-nova', choice: 'old', lang: 'pt' })
    const id = readInstall(dir, '0.2.37', false).id
    expect(calls[1]!.url).toBe('https://x.test/api/surveys/answer')
    expect(body(1)).toEqual({ survey: 'ui-nova', install: id, choice: 'old', version: '0.2.37', first: '0.0.0', os: 'mac', lang: 'pt' })
    await c.answer({ survey: 'ui-nova', choice: 'old', comment: ' A Memória solta na barra. ', lang: 'pt' })
    expect(body(2).comment).toBe('A Memória solta na barra.')
    reply = () => Response.json({ survey: SURVEY })
    expect(await c.survey({ lang: 'pt', force: true })).toBeNull()
  })

  it('"Não quero responder": nothing goes, and it never shows again', async () => {
    reply = () => Response.json({ survey: SURVEY })
    const c = client()
    await c.answer({ survey: 'ui-nova', dismiss: true, lang: 'pt' })
    expect(calls).toHaveLength(0)
    expect(JSON.parse(readFileSync(join(dir, 'install.json'), 'utf8')).surveysDone).toEqual(['ui-nova'])
    expect(await c.survey({ lang: 'pt' })).toBeNull()
  })

  it('off, unreachable or a strange answer: no survey', async () => {
    expect(await client({ url: null }).survey({ lang: 'pt' })).toBeNull()
    expect(calls).toHaveLength(0)
    reply = () => {
      throw new Error('down')
    }
    expect(await client().survey({ lang: 'pt' })).toBeNull()
    expect(surveyOf({ survey: { id: 'Bad Id', question: 'q', options: SURVEY.options } })).toBeNull()
    expect(surveyOf({ survey: { id: 'ok', question: 'q', options: [{ id: 'a', label: 'A' }] } })).toBeNull()
    expect(surveyOf({ survey: null })).toBeNull()
    expect(surveyOf('nope')).toBeNull()
  })

  it('a failed answer says so and is not marked done', async () => {
    reply = () => new Response('', { status: 502 })
    await expect(client().answer({ survey: 'ui-nova', choice: 'new', lang: 'pt' })).rejects.toThrow(/resposta/)
    expect(readInstall(dir, '0.2.37', false).surveysDone).toEqual([])
  })
})
