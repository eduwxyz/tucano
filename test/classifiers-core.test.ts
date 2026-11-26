// The Classifiers section through the real core: an install from before it keeps its Jev and its key,
// keys stay in the secret store, and only an admin touches them. No call leaves this process.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Db } from '../src/core/db'
import type { ClassifierConfig } from '../src/shared/classifiers'
import type { Settings } from '../src/shared/types'
import { bootCore, type Client, type TestCore } from './helpers/core'

type Snap = { settings: Settings }

const jev: ClassifierConfig = { id: 'jev', name: 'Jev', provider: 'typesafe', model: 'jev-latest' }
const luna: ClassifierConfig = { id: 'luna-1', name: 'Luna', provider: 'openai', model: 'gpt-6-luna' }
const LEGACY_KEY = 'legacy-typesafe-value'
const NEW_KEY = 'new-openai-value'

let core: TestCore
let owner: Client
let admin: Client
let member: Client
let db: Db
const settingsOf = async (c: Client): Promise<Settings> => (await c.call<Snap>('snapshot')).settings

beforeAll(async () => {
  core = await bootCore({ server: true })
  owner = core.connect()
  db = new Db(join(core.dataDir, 'tucano.db'))
  db.addPerson({ id: 'an-admin', name: 'Admin', role: 'admin', about: '' })
  db.addPerson({ id: 'a-member', name: 'Member', role: 'member', about: '' })
  admin = core.connect('an-admin')
  member = core.connect('a-member')
}, 30_000)
afterEach(() => {
  vi.unstubAllGlobals()
})
afterAll(() => {
  try {
    rmSync(core.dataDir, { recursive: true, force: true })
  } catch {} // Windows: still open
})

describe('an install from before the section', () => {
  it('keeps a Jev row for a key saved with no job on', async () => {
    db.setSecret('typesafe:key', `plain:${LEGACY_KEY}`)
    const s = await settingsOf(owner)
    expect(s.classifiers).toEqual([jev])
    expect(s.classifierJobs).toEqual({})
    expect(s.classifierKeys).toEqual({ jev: true })
    expect(s.routerModel).toBe('haiku')
  })

  it('keeps who answers in a channel and what finds a click', async () => {
    db.setSettings({ routerModel: 'jev', browserJev: true })
    const s = await settingsOf(owner)
    expect(s.classifierJobs).toEqual({ routing: 'jev', browser: 'jev' })
    expect(s.routerModel).toBe('jev')
    expect(db.getSecret('typesafe:key')).toBe(`plain:${LEGACY_KEY}`)
  })

  it('never puts the key in a snapshot', async () => {
    for (const c of [owner, admin, member]) expect(JSON.stringify(await c.call('snapshot'))).not.toContain(LEGACY_KEY)
  })

  it('adding a row changes neither job', async () => {
    await owner.call('updateSettings', { patch: { classifiers: [jev, luna] } })
    const s = await settingsOf(owner)
    expect(s.classifiers).toEqual([jev, luna])
    expect(s.classifierJobs).toEqual({ routing: 'jev', browser: 'jev' })
    expect(s.routerModel).toBe('jev')
  })
})

describe('who touches a classifier', () => {
  it('shows the rows to an admin and not to a member', async () => {
    expect((await settingsOf(admin)).classifiers).toEqual([jev, luna])
    const m = await settingsOf(member)
    expect(m.classifiers).toBeUndefined()
    expect(m.classifierJobs).toBeUndefined()
    expect(m.classifierKeys).toBeUndefined()
  })

  it('refuses a member, for the rows, the jobs and the keys', async () => {
    await expect(member.call('updateSettings', { patch: { classifiers: [] } })).rejects.toThrow(/admin/i)
    await expect(member.call('updateSettings', { patch: { classifierJobs: {} } })).rejects.toThrow(/admin/i)
    await expect(member.call('setClassifierKey', { id: 'luna-1', key: 'x' })).rejects.toThrow(/admin/i)
    expect((await settingsOf(owner)).classifiers).toEqual([jev, luna])
  })

  it('checks the key with that row’s provider, and keeps it encrypted', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => (urls.push(String(url)), new Response('{}')))
    await admin.call('setClassifierKey', { id: 'luna-1', key: NEW_KEY })
    expect(urls).toEqual(['https://api.openai.com/v1/models'])
    expect(db.getSecret('classifier:luna-1:key')).toBe(`plain:${NEW_KEY}`)
    expect((await settingsOf(owner)).classifierKeys).toEqual({ jev: true, 'luna-1': true })
    expect(JSON.stringify(await owner.call('snapshot'))).not.toContain(NEW_KEY)
  })

  it('never lets a saved row move to another provider, where its key would follow', async () => {
    await expect(owner.call('updateSettings', { patch: { classifiers: [jev, { ...luna, provider: 'gemini' }] } })).rejects.toThrow(/provider/i)
    await expect(owner.call('updateSettings', { patch: { classifiers: [{ ...luna, id: 'x', provider: 'elsewhere' }] } })).rejects.toThrow(/provider/i)
    await expect(owner.call('updateSettings', { patch: { classifiers: null } })).rejects.toThrow()
    expect((await settingsOf(owner)).classifiers).toEqual([jev, luna])
  })

  it('keeps only jobs that exist, on rows that exist', async () => {
    await owner.call('updateSettings', { patch: { classifierJobs: { routing: 'jev', browser: 'gone', recommend: 'jev' } } })
    expect((await settingsOf(owner)).classifierJobs).toEqual({ routing: 'jev' })
  })
})

describe('turning things off', () => {
  it('takes the router back to a model when its job goes off', async () => {
    await owner.call('updateSettings', { patch: { classifierJobs: {} } })
    expect((await settingsOf(owner)).routerModel).toBe('haiku')
  })

  it('removing a key takes routing off that row and leaves the other job', async () => {
    await owner.call('updateSettings', { patch: { classifierJobs: { routing: 'luna-1', browser: 'luna-1' } } })
    await owner.call('setClassifierKey', { id: 'luna-1', key: null })
    const s = await settingsOf(owner)
    expect(s.classifierJobs).toEqual({ browser: 'luna-1' })
    expect(db.getSecret('classifier:luna-1:key')).toBeUndefined()
  })

  it('removing a row deletes its key, the old name included', async () => {
    await owner.call('updateSettings', { patch: { classifiers: [luna], classifierJobs: { browser: 'luna-1' } } })
    expect(db.getSecret('typesafe:key')).toBeUndefined()
    expect(db.getSecret('classifier:jev:key')).toBeUndefined()
    expect((await settingsOf(owner)).classifiers).toEqual([luna])
  })
})
