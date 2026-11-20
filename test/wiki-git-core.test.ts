// The wiki's git sync through the real core's API (fake engines, a local bare repository): only the
// owner and admins set it up; connecting with "merge" brings the repository and the pages the wiki
// had together, held pages staying held and out of the repository.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { NEEDS } from '../src/core/policy-people'
import type { Person, WikiGitStatus, WikiGitTest } from '../src/shared/types'
import { bootCore, type Client, type TestCore } from './helpers/core'

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 })

let core: TestCore
let ana: Client // the owner
let bia: Client // a member
let caio: Client // an admin
let bare: string
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'E', GIT_AUTHOR_EMAIL: 'e@x', GIT_COMMITTER_NAME: 'E', GIT_COMMITTER_EMAIL: 'e@x' } })
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)
const join_ = async (role: 'member' | 'admin', name: string): Promise<Client> => {
  const { code } = await ana.call<{ code: string }>('createInvite', { role })
  const r = await core.ask<{ data: { person?: Person } }>({ type: 'join', code, name }, 'join-result')
  return core.connect(r.data.person!.id)
}

beforeAll(async () => {
  core = await bootCore({ server: true })
  ana = core.connect()
  await ana.call('setMyName', { name: 'Ana' })
  // the vault, on "GitHub", with two notes
  const root = mkdtempSync(join(tmpdir(), 'tucano-git-core-'))
  bare = join(root, 'vault.git')
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', bare])
  const mac = join(root, 'mac')
  execFileSync('git', ['clone', '--quiet', bare, mac], { stdio: 'ignore' })
  git(mac, 'checkout', '--quiet', '-B', 'main')
  mkdirSync(join(mac, 'Clientes'))
  writeFileSync(join(mac, 'Clientes', 'Marcos Lima.md'), 'Cliente da reforma (do repositório).\n') // the same page as the wiki's, in a folder
  writeFileSync(join(mac, 'Obra.md'), 'A obra.\n')
  git(mac, 'add', '-A')
  git(mac, 'commit', '--quiet', '-m', 'vault')
  git(mac, 'push', '--quiet', 'origin', 'main')
}, 30_000)
afterAll(() => {
  try { rmSync(core.dataDir, { recursive: true, force: true }) } catch {} // Windows: still open
})

describe('who sets it up', () => {
  it('every git RPC is the owner’s and the admins’ at the door', () => {
    for (const m of ['wikiGitStatus', 'wikiGitSetup', 'wikiGitTest', 'wikiGitConnect', 'wikiGitSync', 'wikiGitDisconnect'] as const) expect(NEEDS[m], m).toBe('admin')
  })

  it('a member is refused; an admin is let in', async () => {
    // Ana's wiki before: a page of the team's and one held for her (the heritage)
    await ana.call('wikiSave', { title: 'Marcos Lima', body: 'Cliente (da wiki do Tucano).' })
    await ana.call('wikiSave', { title: 'Plano da Ana', body: 'Só dela.' })
    await ana.call('wikiSave', { title: 'Fornecedores', body: 'Lista.' })
    bia = await join_('member', 'Bia')
    caio = await join_('admin', 'Caio')
    for (const [m, p] of [['wikiGitStatus', {}], ['wikiGitSetup', { url: `file://${bare}` }], ['wikiGitTest', {}], ['wikiGitConnect', { how: 'merge' }], ['wikiGitSync', {}], ['wikiGitDisconnect', {}]] as const) expect(await err(bia.call(m, p)), m).toBe('Só um admin pode fazer isso.')
    expect((await caio.call<WikiGitStatus>('wikiGitStatus')).state).toBe('off')
  })
})

describe('connecting with merge', () => {
  it('sets up, tests, connects, and the wiki is the repository plus what it had', async () => {
    const setup = await ana.call<{ publicKey: string }>('wikiGitSetup', { url: `file://${bare}` })
    expect(setup.publicKey).toMatch(/^ssh-ed25519 /)
    const t = await ana.call<WikiGitTest>('wikiGitTest')
    expect(t).toMatchObject({ pages: 2, pdfs: 0, docx: 0, branch: 'main' })
    expect(t.currentPages).toBeGreaterThanOrEqual(3)
    // held for Ana since Bia came in? Only what came from her DMs; hold one by hand as the heritage does
    const { DatabaseSync } = await import('node:sqlite')
    const idx = readdirIndex(core.dataDir)
    const db = new DatabaseSync(idx)
    db.prepare("INSERT OR IGNORE INTO held (title, person, at) VALUES ('plano da ana', ?, 1)").run((await ana.call<{ you: string }>('snapshot')).you)
    db.close()
    const old = join(core.dataDir, 'wiki', 'pages')
    const st = await ana.call<WikiGitStatus>('wikiGitConnect', { how: 'merge' })
    expect(st).toMatchObject({ state: 'ok', readOnly: false, branch: 'main' })
    const w = await ana.call<{ pages: { title: string }[]; dir: string; git?: { readOnly: boolean } }>('wiki')
    expect(w.dir).toBe(join(core.dataDir, 'wiki-repo'))
    expect(w.git).toMatchObject({ readOnly: false, state: 'ok' })
    expect(w.pages.map((p) => p.title).sort()).toEqual(['Fornecedores', 'Marcos Lima', 'Marcos Lima (versão do Tucano)', 'Obra', 'Plano da Ana'])
    // the repository's version stayed; the old wiki's came in next to it
    expect(readFileSync(join(w.dir, 'Clientes', 'Marcos Lima.md'), 'utf8')).toContain('do repositório')
    expect(existsSync(join(w.dir, 'Marcos Lima.md'))).toBe(false)
    // the old folder is still there, as it was
    expect(existsSync(join(old, 'Plano da Ana.md'))).toBe(true)
    const files = git(bare, '-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', 'main')
    expect(files).toContain('Fornecedores.md')
    expect(files).toContain('Marcos Lima (versão do Tucano).md')
    expect(files).not.toContain('Plano da Ana')
    expect(git(bare, 'log', '-1', '--format=%s')).toMatch(/^Tucano: juntou \d+ arquivos da wiki anterior \(Ana\)/)
    // Bia doesn't see the held page; it's still held
    expect((await bia.call<{ pages: { title: string }[] }>('wiki')).pages.map((p) => p.title)).not.toContain('Plano da Ana')
    // a member writing a page: committed with her name
    await bia.call('wikiSave', { title: 'Nota da Bia', body: 'Oi.' })
    await ana.call('wikiGitSync', {})
    expect(git(bare, 'log', '-1', '--format=%s|%an').trim()).toBe('Tucano: Nota da Bia (Bia)|Bia')
    // the folder can't be swapped while it's the repository's
    expect(await err(ana.call('setWikiDir', { dir: tmpdir() }))).toContain('Desconecte o git')
    const off = await ana.call<WikiGitStatus>('wikiGitDisconnect')
    expect(off.state).toBe('off')
    expect((await ana.call<{ dir: string }>('wiki')).dir).toBe(w.dir) // the folder stays
  })
})

// The index of the wiki's default folder (wiki.db, next to the data).
function readdirIndex(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true })
  return join(dataDir, 'wiki.db')
}
