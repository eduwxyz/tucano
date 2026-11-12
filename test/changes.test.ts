import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Changes, CHANGE_FILES_SHOWN, homePath, lineChange, parseChanges, touched, type ChangeScope, type ChangeSetRow } from '../src/core/changes'

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })

let base: string
let repo: string
let rows: Map<string, ChangeSetRow>
let changes: Changes

const scope = (): ChangeScope => ({ bases: [base], toHost: (p) => (p.startsWith('/') ? p : join(base, p)), shown: (h) => h.replace(base, '/work') })

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'tucano-changes-'))
  repo = join(base, 'app')
  mkdirSync(join(repo, 'src'), { recursive: true })
  sh(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'src', 'checkout.ts'), 'export const total = 1\nexport const tax = 2\n')
  writeFileSync(join(repo, 'old.txt'), 'legacy\nlines\n')
  writeFileSync(join(repo, 'utils.ts'), 'export const id = (x: number) => x\n'.repeat(5))
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n')
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-q', '-m', 'first')
  rows = new Map()
  changes = new Changes({ saveChangeSet: (r) => rows.set(r.id, r), changeSet: (id) => rows.get(id) })
})

afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }))

describe('a reply’s changes', () => {
  it('shows what a turn created, changed, renamed and deleted, whatever did it', async () => {
    writeFileSync(join(repo, 'staged.txt'), 'mine\n')
    sh(repo, 'add', 'staged.txt') // the person's own staged work, before the turn
    const turn = changes.turn(scope())
    await turn.prepare('bash', { command: 'cd /work/app && npm test' })
    writeFileSync(join(repo, 'src', 'checkout.ts'), 'export const total = 1\nexport const tax = 3\nexport const fee = 4\n')
    writeFileSync(join(repo, 'src', 'refund.ts'), 'a\nb\nc\n')
    rmSync(join(repo, 'old.txt'))
    sh(repo, 'mv', 'utils.ts', 'lib.ts')
    mkdirSync(join(repo, 'node_modules'))
    writeFileSync(join(repo, 'node_modules', 'x.js'), 'ignored')
    const [set] = await turn.finish('m1', 'a1')
    expect(set!.root).toBe(repo.replace(base, '/work'))
    const byPath = Object.fromEntries(set!.files.map((f) => [f.path, f]))
    expect(byPath['src/checkout.ts']).toMatchObject({ kind: 'modified', added: 2, removed: 1 })
    expect(byPath['src/refund.ts']).toMatchObject({ kind: 'added', added: 3, removed: 0 })
    expect(byPath['old.txt']).toMatchObject({ kind: 'deleted', removed: 2 })
    expect(byPath['lib.ts']).toMatchObject({ kind: 'renamed', from: 'utils.ts' })
    expect(byPath['staged.txt']).toBeUndefined() // there before the turn
    expect(Object.keys(byPath).some((p) => p.startsWith('node_modules'))).toBe(false)
    expect(set).toMatchObject({ total: 4, added: 5, removed: 3, branch: 'main' })
    expect(set!.fromBranch).toBeUndefined()
    // The person's staging area is as it was.
    expect(sh(repo, 'diff', '--cached', '--no-renames', '--name-only').trim()).toBe('lib.ts\nstaged.txt\nutils.ts')

    const diff = await changes.diff(set!.id, 'src/checkout.ts')
    expect('patch' in diff && diff.patch).toContain('-export const tax = 2\n+export const tax = 3\n+export const fee = 4')
    const renamed = await changes.diff(set!.id, 'lib.ts')
    expect('patch' in renamed && renamed.patch).toContain('rename from utils.ts')
    expect(await changes.diff(set!.id, 'nope.ts')).toEqual({ error: 'gone' })
  })

  it('says the branch the work ended on, and the one it started from when the turn moved', async () => {
    const turn = changes.turn(scope())
    await turn.prepare('bash', { command: 'cd /work/app && git checkout -b feat/refunds' })
    sh(repo, 'checkout', '-q', '-b', 'feat/refunds')
    writeFileSync(join(repo, 'old.txt'), 'changed\n')
    const [set] = await turn.finish('m1', 'a1')
    expect(set).toMatchObject({ branch: 'feat/refunds', fromBranch: 'main' })
  })

  it('finds a repository when the agent’s folder is named another way than git names it', async () => {
    // A link to the folder stands for /var and /private/var on macOS, or C:\Users\RUNNER~1 on Windows.
    const named = join(mkdtempSync(join(tmpdir(), 'tucano-link-')), 'work')
    symlinkSync(base, named, 'junction')
    const turn = changes.turn({ bases: [named], toHost: (p) => join(named, p), shown: (h) => h.replace(named, '/work') })
    await turn.prepare('edit_file', { path: 'app/old.txt' })
    writeFileSync(join(repo, 'old.txt'), 'changed\n')
    const [set] = await turn.finish('m1', 'a1')
    expect(set).toMatchObject({ root: join(named, 'app').replace(named, '/work'), total: 1 })
    rmSync(dirname(named), { recursive: true, force: true })
  })

  it('finds the repositories in the agent’s folders before the first write', async () => {
    const turn = changes.turn(scope())
    await turn.prepare('write_file', { path: '/tmp/elsewhere.txt', content: 'x' })
    writeFileSync(join(repo, 'old.txt'), 'changed\n')
    const sets = await turn.finish('m1', 'a1')
    expect(sets).toHaveLength(1)
    expect(sets[0]!.files).toEqual([{ path: 'old.txt', kind: 'modified', added: 1, removed: 2 }])
  })

  it('keeps nothing when the turn changed nothing, or only read', async () => {
    const read = changes.turn(scope())
    await read.prepare('read_file', { path: '/work/app/old.txt' })
    expect(await read.finish('m1', 'a1')).toEqual([])
    const idle = changes.turn(scope())
    await idle.prepare('bash', { command: 'ls' })
    expect(await idle.finish('m1', 'a1')).toEqual([])
    expect(rows.size).toBe(0)
    expect(sh(repo, 'for-each-ref', 'refs/tucano').trim()).toBe('')
  })

  it('carries the first files and gives the rest on asking', async () => {
    const turn = changes.turn(scope())
    await turn.prepare('bash', { command: 'make' })
    for (let i = 0; i < CHANGE_FILES_SHOWN + 7; i++) writeFileSync(join(repo, `gen-${String(i).padStart(2, '0')}.txt`), `${i}\n`)
    const [set] = await turn.finish('m1', 'a1')
    expect(set!.total).toBe(CHANGE_FILES_SHOWN + 7)
    expect(set!.files).toHaveLength(CHANGE_FILES_SHOWN)
    expect(changes.files(set!.id, CHANGE_FILES_SHOWN)).toHaveLength(7)
  })

  it('leaves alone a folder without git, and a repository around the agent’s folder', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'tucano-outer-'))
    try {
      sh(outer, 'init', '-q')
      const inner = join(outer, 'data', 'work')
      mkdirSync(inner, { recursive: true })
      const turn = changes.turn({ bases: [inner], toHost: (p) => join(inner, p), shown: (h) => h })
      await turn.prepare('write_file', { path: 'notes.txt', content: 'x' })
      writeFileSync(join(inner, 'notes.txt'), 'x\n')
      expect(await turn.finish('m1', 'a1')).toEqual([])
    } finally {
      rmSync(outer, { recursive: true, force: true })
    }
  })

  it('says the diff is gone when the repository lost its snapshots', async () => {
    const turn = changes.turn(scope())
    await turn.prepare('bash', { command: 'x' })
    writeFileSync(join(repo, 'old.txt'), 'new\n')
    const [set] = await turn.finish('m1', 'a1')
    rmSync(join(repo, '.git'), { recursive: true, force: true })
    sh(repo, 'init', '-q')
    expect(await changes.diff(set!.id, 'old.txt')).toEqual({ error: 'gone' })
    expect(readFileSync(join(repo, 'old.txt'), 'utf8')).toBe('new\n')
  })
})

describe('the paths a call may change', () => {
  it('reads the file of a write and where a command goes', () => {
    expect(touched('edit_file', { path: 'src/a.ts' })).toEqual(['src/a.ts'])
    expect(touched('bash', { command: 'cd /projetos/loja && npm test; git -C "/work/my app" status' })).toEqual(['/projetos/loja', '/work/my app'])
    expect(touched('bash', { command: 'cd $HOME && ls' })).toEqual([])
    expect(touched('read_file', { path: 'x' })).toEqual([])
  })
})

describe('counting lines', () => {
  it('counts like a diff', () => {
    expect(lineChange('', 'a\nb\n')).toEqual({ added: 2, removed: 0 })
    expect(lineChange('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ added: 2, removed: 1 })
    expect(lineChange('same', 'same')).toEqual({ added: 0, removed: 0 })
  })

  it('reads git’s numstat and name-status', () => {
    const files = parseChanges('3\t1\tsrc/a.ts\0-\t-\tlogo.png\x000\t0\t\0old.ts\0new.ts\0', 'M\0src/a.ts\0A\0logo.png\0R100\0old.ts\0new.ts\0')
    expect(files).toEqual([
      { path: 'src/a.ts', kind: 'modified', added: 3, removed: 1 },
      { path: 'logo.png', kind: 'added', added: 0, removed: 0, binary: true },
      { path: 'new.ts', kind: 'renamed', from: 'old.ts', added: 0, removed: 0 }
    ])
  })
})

describe('a reply on this computer', () => {
  it('ends with the files it changed, and each write counts its lines', async () => {
    const { Db } = await import('../src/core/db')
    const { Computers } = await import('../src/core/computer')
    const { Gateway } = await import('../src/core/gateway')
    const { Runner } = await import('../src/core/runs')
    const { fakeEngine } = await import('../src/core/engines/fake')
    const ready = { installed: true, loggedIn: true }
    const dataDir = mkdtempSync(join(tmpdir(), 'tucano-changes-run-'))
    const db = new Db(join(dataDir, 'test.db'))
    const id = 'c4a46e00-0000-4000-8000-000000000001'
    db.saveAgent({ id, name: 'Leo', handle: 'leo', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: true, computerKind: 'mac', archived: false })
    db.createConversation({ id: 'd1', kind: 'dm', name: id, members: [id] })
    const computers = new Computers({ db, dataDir, emit: () => {} })
    const app = join(computers.mac.cwd(db.agent(id)!), 'app')
    mkdirSync(app, { recursive: true })
    sh(app, 'init', '-q')
    writeFileSync(join(app, 'checkout.ts'), 'const tax = 2\nconst total = 1\n')
    writeFileSync(join(app, 'legacy.ts'), 'old\n')
    sh(app, 'add', '-A')
    sh(app, 'commit', '-q', '-m', 'first')
    const gateway = new Gateway()
    await gateway.start()
    const engines = Object.fromEntries((['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok', 'cline', 'hermes'] as const).map((e) => [e, fakeEngine(e, { delayMs: 1 })]))
    const settings = { workspaceName: 'Edu', context: '', engines: Object.fromEntries(Object.keys(engines).map((e) => [e, ready])), routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'en' }
    const changes = new Changes({ saveChangeSet: (r) => db.saveChangeSet(r), changeSet: (cid) => db.changeSet(cid) })
    // @ts-expect-error: the engines and settings are the test's own, complete for what a reply reads
    const runner = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'tucano-w-')), gateway, computers, changes })
    try {
      await runner.send('d1', 'mude o código:\ntroque `const tax = 2` por `const tax = 3\\nconst fee = 4` em `app/checkout.ts`\nescreva `app/refund.ts`: export const refund = true\nrode `rm app/legacy.ts`')
      await runner.idle()
      const reply = db.messages().find((m) => m.author.kind === 'agent')!
      const [set] = reply.run!.changes!
      expect(set).toMatchObject({ total: 3, root: homePath(app) })
      expect(Object.fromEntries(set!.files.map((f) => [f.path, [f.kind, f.added, f.removed]]))).toEqual({ 'checkout.ts': ['modified', 2, 1], 'refund.ts': ['added', 1, 0], 'legacy.ts': ['deleted', 0, 1] })
      expect(reply.run!.steps.filter((s) => s.change).map((s) => s.change)).toEqual([{ added: 2, removed: 1 }, { added: 1, removed: 0 }])
      const diff = await changes.diff(set!.id, 'checkout.ts')
      expect('patch' in diff && diff.patch).toContain('+const fee = 4')
    } finally {
      await gateway.stop()
      db.close() // Windows won't delete an open database
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
    }
  }, 30_000)
})
