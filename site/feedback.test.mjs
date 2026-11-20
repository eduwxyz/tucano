// The app's feedback and survey routes against a fake Supabase: nothing leaves the machine.
//   node --test site/
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import worker from './worker.js'
import { compare, fits, picture, sweep } from './feedback.js'
import * as fb from './feedback.js' // the routes, for a rate limit only they see

const env = { SUPABASE_URL: 'https://db.example', SUPABASE_SECRET_KEY: 'sb_secret_test', ASSETS: { fetch: async () => new Response('page') } }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString('base64')
const SURVEY = {
  id: 'ui-nova',
  question_pt: 'A barra lateral mudou. Prefere a nova ou a de antes?',
  question_en: 'The sidebar changed. Do you prefer the new one or the old one?',
  options: [{ id: 'new', pt: 'A nova', en: 'The new one' }, { id: 'old', pt: 'A de antes', en: 'The old one' }],
  follow_up_pt: 'O que faz falta?',
  follow_up_en: null,
  active: true,
  min_version: '0.2.37',
  first_version_before: '0.2.37',
  platforms: null,
  langs: null,
  ends_at: null,
}

let calls, surveysRows, status
beforeEach(() => {
  calls = []
  surveysRows = [SURVEY]
  status = {}
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, init, method: init.method ?? 'GET' })
    const key = Object.keys(status).find((k) => u.includes(k))
    if (key) return new Response('boom', { status: status[key] })
    if (u.includes('/rest/v1/surveys')) return Response.json(surveysRows)
    if (u.includes('/storage/v1/object/list/')) return Response.json([{ name: 'old.png', created_at: '2020-01-01T00:00:00Z' }, { name: 'new.png', created_at: new Date().toISOString() }])
    return new Response('', { status: 201 })
  }
})

const req = (path, init = {}) => worker.fetch(new Request(`https://tucano.sh${path}`, init), env)
const post = (path, body, headers = {}) => req(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const sent = (part) => calls.find((c) => c.url.includes(part))

test('feedback: the text is saved with the secret key, and the picture goes to the private bucket first', async () => {
  const r = await post('/api/feedback', { kind: 'bug', message: '  o botão sumiu  ', image: PNG, version: '0.2.36', os: 'mac', lang: 'pt' })
  assert.equal(r.status, 200)
  const up = sent('/storage/v1/object/feedback/')
  assert.match(up.url, /\/storage\/v1\/object\/feedback\/[0-9a-f-]{36}\.png$/)
  assert.equal(up.init.headers['content-type'], 'image/png')
  assert.equal(up.init.headers.apikey, 'sb_secret_test')
  const row = JSON.parse(sent('/rest/v1/feedback').init.body)
  assert.equal(row.message, 'o botão sumiu')
  assert.equal(row.kind, 'bug')
  assert.equal(row.image_path, up.url.split('/').pop())
  assert.deepEqual([row.app_version, row.os, row.lang], ['0.2.36', 'mac', 'pt'])
  assert.ok(calls.indexOf(up) < calls.indexOf(sent('/rest/v1/feedback')))
})

test('feedback: a picture that fails to upload still leaves the text', async () => {
  status['/storage/v1/object/feedback/'] = 500
  assert.equal((await post('/api/feedback', { kind: 'idea', message: 'x', image: JPG })).status, 200)
  assert.equal(JSON.parse(sent('/rest/v1/feedback').init.body).image_path, null)
})

test('feedback: no kind, no text, a fake picture or a GET are refused, and nothing is saved', async () => {
  for (const body of [{ kind: 'nope', message: 'x' }, { kind: 'bug', message: '   ' }, { kind: 'bug', message: 'x', image: Buffer.from('<svg/>').toString('base64') }]) {
    assert.equal((await post('/api/feedback', body)).status, 400)
  }
  assert.equal((await req('/api/feedback')).status, 405)
  assert.equal(calls.length, 0)
})

test('feedback: too big, or too many from one address', async () => {
  assert.equal((await post('/api/feedback', { kind: 'bug', message: 'x', image: 'A'.repeat(4_700_000) })).status, 413)
  const limited = { ...env, FEEDBACK_LIMIT: { limit: async ({ key }) => ({ success: key !== '1.2.3.4' }) } }
  const r = await fb.feedback(new Request('https://tucano.sh/api/feedback', { method: 'POST', headers: { 'cf-connecting-ip': '1.2.3.4' }, body: JSON.stringify({ kind: 'bug', message: 'x' }) }), limited)
  assert.equal(r.status, 429)
  assert.equal(calls.length, 0)
})

test('feedback: Supabase down is a 502, without the details', async () => {
  status['/rest/v1/feedback'] = 500
  const r = await post('/api/feedback', { kind: 'bug', message: 'x' })
  assert.equal(r.status, 502)
  assert.deepEqual(await r.json(), { error: 'save' })
})

test('picture: PNG and JPEG by their bytes', () => {
  assert.equal(picture(PNG).ext, 'png')
  assert.equal(picture(JPG).type, 'image/jpeg')
  assert.equal(picture('%%%').error, 'image')
  assert.equal(picture(Buffer.alloc(3 * 1024 * 1024 + 10, 0xff).toString('base64')).error, 'image too large')
})

test('surveys: the one that fits this install, in its language', async () => {
  const r = await req('/api/surveys?version=0.2.37&first=0.2.30&os=mac&lang=pt')
  assert.deepEqual(await r.json(), {
    survey: { id: 'ui-nova', question: SURVEY.question_pt, options: [{ id: 'new', label: 'A nova' }, { id: 'old', label: 'A de antes' }], followUp: 'O que faz falta?' },
  })
  assert.match(sent('/rest/v1/surveys').url, /active=is\.true/)
  const en = (await (await req('/api/surveys?version=0.2.37&first=0.2.30&os=mac&lang=en')).json()).survey
  assert.equal(en.options[0].label, 'The new one')
  assert.equal(en.followUp, undefined)
})

test('surveys: none for an older app, a newer install, or one that ended', async () => {
  assert.equal((await (await req('/api/surveys?version=0.2.36&first=0.2.30')).json()).survey, null)
  assert.equal((await (await req('/api/surveys?version=0.2.40&first=0.2.37')).json()).survey, null)
  assert.equal((await (await req('/api/surveys?version=0.2.40')).json()).survey, null) // no first version: not "before"
  surveysRows = [{ ...SURVEY, ends_at: '2020-01-01T00:00:00Z' }]
  assert.equal((await (await req('/api/surveys?version=0.2.40&first=0.2.30')).json()).survey, null)
  status['/rest/v1/surveys'] = 500
  assert.deepEqual(await (await req('/api/surveys?version=0.2.40&first=0.2.30')).json(), { survey: null })
})

test('fits and compare', () => {
  assert.equal(compare('0.2.10', '0.2.9'), 1)
  assert.equal(compare('1.0.0', '1.0.0'), 0)
  const open = { ...SURVEY, min_version: null, first_version_before: null }
  assert.ok(fits(open, { os: 'linux', lang: 'en' }))
  assert.ok(!fits({ ...open, platforms: ['mac'] }, { os: 'windows', lang: 'pt' }))
  assert.ok(!fits({ ...open, langs: ['pt'] }, { os: 'mac', lang: 'en' }))
})

const INSTALL = '0b9c4b0e-6f0e-4a59-9a8e-2d6f3c1b7a10'

test('answer: saved once per install, replacing an earlier one; no comment keeps the earlier comment', async () => {
  const r = await post('/api/surveys/answer', { survey: 'ui-nova', install: INSTALL.toUpperCase(), choice: 'new', version: '0.2.37', first: '0.2.30', os: 'mac', lang: 'pt' })
  assert.equal(r.status, 200)
  const call = sent('/rest/v1/survey_answers')
  assert.match(call.url, /on_conflict=survey_id,install_id/)
  assert.match(call.init.headers.prefer, /resolution=merge-duplicates/)
  const row = JSON.parse(call.init.body)
  assert.equal(row.install_id, INSTALL)
  assert.equal(row.choice, 'new')
  assert.ok(!('comment' in row))
  calls = []
  await post('/api/surveys/answer', { survey: 'ui-nova', install: INSTALL, choice: 'new', comment: ' a Memória ' })
  assert.equal(JSON.parse(sent('/rest/v1/survey_answers').init.body).comment, 'a Memória')
})

test('answer: an unknown survey, a stopped one, a bad install id or a choice the database refuses', async () => {
  assert.equal((await post('/api/surveys/answer', { survey: 'Nope!', install: INSTALL, choice: 'new' })).status, 400)
  assert.equal((await post('/api/surveys/answer', { survey: 'ui-nova', install: 'abc', choice: 'new' })).status, 400)
  assert.equal((await post('/api/surveys/answer', { survey: 'other', install: INSTALL, choice: 'new' })).status, 404)
  surveysRows = []
  assert.equal((await post('/api/surveys/answer', { survey: 'ui-nova', install: INSTALL, choice: 'new' })).status, 404)
  surveysRows = [SURVEY]
  status['/rest/v1/survey_answers'] = 400
  assert.deepEqual(await (await post('/api/surveys/answer', { survey: 'ui-nova', install: INSTALL, choice: 'zzz' })).json(), { error: 'choice' })
})

test('sweep: pictures older than 90 days leave the bucket and their rows', async () => {
  assert.equal(await sweep(env), 1)
  const del = calls.find((c) => c.method === 'DELETE')
  assert.deepEqual(JSON.parse(del.init.body), { prefixes: ['old.png'] })
  const patch = calls.find((c) => c.method === 'PATCH')
  assert.match(patch.url, /\/rest\/v1\/feedback\?created_at=lt\..+&image_path=not\.is\.null/)
  assert.deepEqual(JSON.parse(patch.init.body), { image_path: null })
})
