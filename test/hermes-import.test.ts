// Importing from Hermes Agent's own folder (spec §26, src/core/hermes-import.ts), on a synthetic
// ~/.hermes laid out the way Hermes writes it.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { applyForeignTeam, IMPORT_CAPS } from '../src/core/agent-import'
import { gatewaysNote, hermesPreview, hermesRoot, hermesSchedule, hermesTeam, readHermes } from '../src/core/hermes-import'
import { personScope } from '../src/shared/types'

const fresh = (): Db => new Db(join(mkdtempSync(join(tmpdir(), 'hermes-import-db-')), 'test.db'))
const SECRET = 'sk-ant-THIS-MUST-NEVER-BE-READ'

function folder(files: Record<string, string>): string {
  const root = join(mkdtempSync(join(tmpdir(), 'hermes-')), '.hermes')
  for (const [path, text] of Object.entries(files)) {
    const p = join(root, ...path.split('/'))
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
  }
  return root
}

const skill = (name: string, body = `# ${name}\n\nDo it well.`): string => `---\nname: ${name}\ndescription: The ${name} recipe.\n---\n${body}\n`

// Hermes's dir_hash for a folder whose only file is SKILL.md (no separator in the path: the same on Windows).
const md5 = (...parts: string[]): string => parts.reduce((h, p) => h.update(p), createHash('md5')).digest('hex')
const onlySkill = (text: string): string => md5('SKILL.md', text)

const base: Record<string, string> = {
  '.env': `ANTHROPIC_API_KEY=${SECRET}\nTELEGRAM_BOT_TOKEN=${SECRET}\n`,
  'auth.json': JSON.stringify({ token: SECRET }),
  'SOUL.md': 'You are Hermes, my research partner. Answer in Portuguese.',
  'memories/MEMORY.md': 'The repo is eduwxyz/tucano.\n§\nRun npm test before a PR.',
  'memories/USER.md': 'Eduardo prefers small PRs.\n§\nEduardo lives in São Paulo.',
  'skills/.bundled_manifest': `arxiv:${onlySkill(skill('arxiv'))}\ngithub-pr-workflow\n`,
  'skills/research/arxiv/SKILL.md': skill('arxiv'), // came with Hermes
  'skills/github/github-pr-workflow/SKILL.md': skill('github-pr-workflow'), // came with Hermes
  'skills/.hub/lock.json': '{}',
  'skills/.archive/old/SKILL.md': skill('old'),
  'skills/weekly-report/SKILL.md': skill('weekly-report'),
  'skills/weekly-report/references/template.md': 'a template',
  'skills/writing/release-notes/SKILL.md': skill('release-notes'),
  'cron/jobs.json': JSON.stringify({
    jobs: [
      { id: 'a1', name: 'Morning brief', prompt: 'Summarize the news.', schedule: { kind: 'cron', expr: '0 9 * * 1-5', display: 'weekdays at 9am' }, enabled: true },
      { id: 'a2', name: 'Monthly bill', prompt: 'Check the bill.', schedule: { kind: 'cron', expr: '30 8 5 * *' } },
      { id: 'a3', name: 'Every 30 minutes', prompt: 'Ping.', schedule: { kind: 'interval', minutes: 30 } },
      { id: 'a4', name: 'Twice a day', prompt: 'Check.', schedule: { kind: 'cron', expr: '0 9,17 * * *' } },
      { id: 'a5', name: 'Backup script', prompt: '', no_agent: true, script: 'backup.sh', schedule: { kind: 'cron', expr: '0 3 * * *' } }
    ]
  }),
  'cron/output/a1/2026-11-01.md': 'old output',
  'config.yaml': [
    'model:',
    '  default: anthropic/claude-opus-4.6',
    '  provider: openrouter',
    'agent:',
    '  reasoning_effort: high',
    'mcp_servers:',
    '  github:',
    '    command: npx',
    `    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${SECRET}" }`,
    '  notion:',
    '    url: https://mcp.notion.com/mcp',
    '  old:',
    '    command: x',
    '    enabled: false',
    'platforms:',
    '  telegram:',
    '    reply_to_mode: first',
    'discord:',
    '  require_mention: true',
    ''
  ].join('\n'),
  'sessions/s1.json': `{"text": "${SECRET}"}`,
  'state.db': SECRET,
  'logs/errors.log': SECRET
}

describe('Hermes import: reading the folder', () => {
  it('reads only the allowed files: never .env, auth.json, sessions, state.db or logs', () => {
    const root = folder({ ...base, 'profiles/coder/.env': SECRET, 'profiles/coder/SOUL.md': 'You write code.' })
    const read: string[] = []
    const r = readHermes(root, { onRead: (p) => read.push(p) })
    const rel = read.map((p) => p.slice(root.length + 1).split('\\').join('/'))
    expect(rel.some((p) => /(^|\/)(\.env|auth\.json)$/.test(p))).toBe(false)
    expect(rel.some((p) => /^(sessions|logs|cron\/output)\/|state\.db/.test(p))).toBe(false)
    expect(rel.every((p) => /^(profiles\/[a-z0-9_-]+\/)?(SOUL\.md|config\.yaml|memories\/(MEMORY|USER)\.md|cron\/jobs\.json|skills\/\.bundled_manifest|skills\/.+\/SKILL\.md)$/.test(p))).toBe(true)
    // Not one byte of a secret makes it out, not even the one inside an MCP server's env.
    expect(JSON.stringify(r)).not.toContain(SECRET)
    expect(JSON.stringify(hermesPreview(r))).not.toContain(SECRET)
  })

  it('maps one folder with no profiles to one agent, and previews it', () => {
    const p = hermesPreview(readHermes(folder(base), { now: Date.parse('2026-11-16T12:00:00Z') }))
    expect(p.profiles).toEqual([
      { key: 'default', name: 'Hermes', instructions: true, memories: 2, userMemories: 2, skills: 2, routines: 2, routinesAsNames: ['Every 30 minutes', 'Twice a day', 'Backup script'] }
    ])
    expect(p.servers).toEqual(['github', 'notion'])
    expect(p.gateways.sort()).toEqual(['Discord', 'Telegram'])
    expect(p.models).toEqual(['openrouter/anthropic/claude-opus-4.6'])
    expect(p.notes.join('\n')).toMatch(/2 skills que já vêm com o Hermes|2 skills that come with Hermes/)
    expect(p.notes.join('\n')).toMatch(/sessions, state\.db/)
    // The jobs the preview lists by name aren't repeated in its notes.
    expect(p.notes.join('\n')).not.toContain('Twice a day')
  })

  it('brings every profile as its own agent, and the chosen ones only', () => {
    const root = folder({
      ...base,
      'profiles/coder/SOUL.md': 'You write code.',
      'profiles/coder/skills/refactor/SKILL.md': skill('refactor'),
      'profiles/my-work/memories/MEMORY.md': 'Standup at 10.',
      'profiles/.hidden/SOUL.md': 'no',
      'profiles/Bad Name/SOUL.md': 'no',
      'profiles/empty/notes.txt': 'nothing Hermes reads'
    })
    const r = readHermes(root)
    expect(r.profiles.map((p) => [p.meta.key, p.meta.name])).toEqual([
      ['default', 'Hermes'],
      ['coder', 'Coder'],
      ['my-work', 'My work']
    ])
    expect(r.profiles[1]!.agent.skills.map((k) => k.name)).toEqual(['refactor'])
    const team = hermesTeam(r, ['coder'])
    expect(team.agents.map((a) => a.name)).toEqual(['Coder'])
    expect(team.source).toBe('Hermes')
    expect(() => hermesTeam(r, ['nope'])).toThrow()
  })

  it('reads $HERMES_HOME, and a profile folder there points back to its root', () => {
    expect(hermesRoot({}, '/Users/x')).toBe(join('/Users/x', '.hermes'))
    expect(hermesRoot({ HERMES_HOME: '/opt/hermes' }, '/Users/x')).toBe(resolve('/opt/hermes'))
    expect(hermesRoot({ HERMES_HOME: '/Users/x/.hermes/profiles/coder' }, '/Users/x')).toBe(resolve('/Users/x/.hermes'))
  })

  it('says, in the person’s words, when the folder is not Hermes’s', () => {
    expect(() => readHermes(join(tmpdir(), 'no-such-hermes-folder-xyz'))).toThrow(/pasta|folder/)
    expect(() => readHermes(folder({ 'notes.txt': 'hi', '.env': SECRET }))).toThrow(/Hermes/)
  })

  it('does not take ~/.claude or a project with a config.yaml for Hermes, in pt and en', () => {
    const claude = folder({ 'settings.json': '{}', 'CLAUDE.md': 'Be brief.', 'skills/pdf/SKILL.md': skill('pdf'), 'config.yaml': 'theme: dark\n' })
    const project = folder({ 'config.yaml': 'model: gpt-4\nmcp_servers:\n  x:\n    command: y\n', 'cron/jobs.json': '{"jobs": []}', 'README.md': '# a project' })
    for (const root of [claude, project]) {
      expect(() => readHermes(root)).toThrow(/não parece uma pasta do Hermes|doesn't look like a Hermes folder/)
    }
  })

  it('knows Hermes by its own signs: SOUL.md, memories, the skills manifest, state.db, a config.yaml with _config_version', () => {
    for (const files of [
      { 'SOUL.md': 'x' },
      { 'memories/USER.md': 'x' },
      { 'skills/.bundled_manifest': 'arxiv:abc\n' },
      { 'state.db': SECRET, 'skills/mine/SKILL.md': skill('mine') },
      { 'config.yaml': '_config_version: 14\nmodel: x\n' }
    ] as Record<string, string>[]) {
      const read: string[] = []
      expect(readHermes(folder(files), { onRead: (p) => read.push(p) }).profiles).toHaveLength(1)
      // state.db is only seen, never opened.
      expect(read.some((p) => p.endsWith('state.db'))).toBe(false)
    }
    // The sample folder, and a profile with only a SOUL.md, still pass.
    expect(readHermes(folder(base)).profiles).toHaveLength(1)
    expect(readHermes(folder({ ...base, 'profiles/coder/SOUL.md': 'You write code.', 'profiles/junk/config.yaml': 'a: 1\n' })).profiles.map((p) => p.meta.key)).toEqual(['default', 'coder'])
  })

  it('leaves out the old comment-only SOUL.md scaffold', () => {
    const r = readHermes(folder({ 'SOUL.md': '# Hermes Agent Persona\n\n<!--\nEdit this to customize.\n-->\n', 'memories/MEMORY.md': 'x' }))
    expect(r.profiles[0]!.agent.instructions).toBe('')
    expect(r.profiles[0]!.meta.instructions).toBe(false)
  })

  it('keeps the caps: skills beyond 20, a SKILL.md too big, memories too long or too many', () => {
    const files: Record<string, string> = { 'SOUL.md': 'x' }
    for (let i = 0; i < IMPORT_CAPS.skills + 2; i++) files[`skills/s${String(i).padStart(2, '0')}/SKILL.md`] = skill(`s${String(i).padStart(2, '0')}`)
    files['skills/s00/SKILL.md'] = skill('s00', 'x'.repeat(1_100_000)) // over 1 MB: stays out alone
    files['memories/MEMORY.md'] = ['short one', 'y'.repeat(301), ...Array.from({ length: IMPORT_CAPS.memories + 3 }, (_, i) => `memory ${i}`)].join('\n§\n')
    const a = readHermes(folder(files)).profiles[0]!.agent
    expect(a.skills).toHaveLength(IMPORT_CAPS.skills - 1)
    expect(a.skills.some((k) => k.name === 's00')).toBe(false)
    expect(a.memories).toHaveLength(IMPORT_CAPS.memories)
    expect(a.memories.every((m) => m.length <= 300)).toBe(true)
    const notes = a.notes.join('\n')
    expect(notes).toMatch(/2 skills além de 20|2 skills beyond 20/)
    expect(notes).toMatch(/s00/)
    expect(notes).toMatch(/1 memória com mais de 300|1 memory longer than 300/)
    expect(notes).toMatch(/4 memórias além de 40|4 memories beyond 40/)
  })

  it('does not follow a link out of the Hermes folder', (ctx) => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'))
    writeFileSync(join(outside, 'secret.md'), SECRET)
    const root = folder({ 'memories/MEMORY.md': 'x' })
    try {
      symlinkSync(join(outside, 'secret.md'), join(root, 'SOUL.md'))
    } catch (e) {
      // Windows without Developer Mode can't make links: only there, skip; everywhere else it must run.
      if (process.platform === 'win32' && (e as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
      throw e
    }
    mkdirSync(join(root, 'skills', 'linked'), { recursive: true })
    symlinkSync(join(outside, 'secret.md'), join(root, 'skills', 'linked', 'SKILL.md'))
    const r = readHermes(root)
    expect(JSON.stringify(r)).not.toContain(SECRET)
    expect(r.profiles[0]!.agent.notes.join('\n')).toMatch(/SOUL\.md/)
  })
})

describe('Hermes import: links inside the Hermes folder', () => {
  // Hermes never makes links in its folder: a link, even one that stays inside, isn't followed.
  const link = (target: string, path: string, ctx: { skip: () => void }): boolean => {
    try {
      symlinkSync(target, path)
      return true
    } catch (e) {
      if (process.platform === 'win32' && (e as NodeJS.ErrnoException).code === 'EPERM') {
        ctx.skip()
        return false
      }
      throw e
    }
  }

  it('does not open .env through a SOUL.md or a SKILL.md that points at it', (ctx) => {
    const root = folder({ '.env': `KEY=${SECRET}\n`, 'memories/MEMORY.md': 'x', 'skills/mine/notes.md': 'n' })
    if (!link(join(root, '.env'), join(root, 'SOUL.md'), ctx)) return
    link(join('..', '..', '.env'), join(root, 'skills', 'mine', 'SKILL.md'), ctx)
    const read: string[] = []
    const r = readHermes(root, { onRead: (p) => read.push(p) })
    expect(read.some((p) => p.endsWith('.env'))).toBe(false)
    expect(read.some((p) => p.endsWith('SOUL.md') || p.endsWith('SKILL.md'))).toBe(false)
    expect(JSON.stringify(r)).not.toContain(SECRET)
    expect(JSON.stringify(hermesPreview(r))).not.toContain(SECRET)
  })

  it('does not open .env to hash a stock skill whose file points at it', (ctx) => {
    const ARXIV = skill('arxiv')
    const root = folder({
      '.env': `KEY=${SECRET}\n`,
      'SOUL.md': 'x',
      'skills/.bundled_manifest': `arxiv:${onlySkill(ARXIV)}\n`,
      'skills/arxiv/SKILL.md': ARXIV
    })
    if (!link(join('..', '..', '.env'), join(root, 'skills', 'arxiv', 'notes.md'), ctx)) return
    const read: string[] = []
    const r = readHermes(root, { onRead: (p) => read.push(p) })
    expect(read.some((p) => p.endsWith('.env') || p.endsWith('notes.md'))).toBe(false)
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it('does not walk into a linked folder inside the Hermes folder', (ctx) => {
    const root = folder({ 'SOUL.md': 'x', 'sessions/s1/SKILL.md': skill('s1', SECRET) })
    mkdirSync(join(root, 'skills'), { recursive: true })
    if (!link(join(root, 'sessions', 's1'), join(root, 'skills', 's1'), ctx)) return
    const read: string[] = []
    const r = readHermes(root, { onRead: (p) => read.push(p) })
    expect(read.some((p) => p.includes('sessions') || p.includes('s1'))).toBe(false)
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it('still reads a Hermes folder that is itself a link (~/.hermes -> elsewhere)', (ctx) => {
    const real = folder({ 'SOUL.md': 'You are Hermes.' })
    const alias = join(mkdtempSync(join(tmpdir(), 'alias-')), '.hermes')
    if (!link(real, alias, ctx)) return
    expect(readHermes(alias).profiles[0]!.agent.instructions).toContain('You are Hermes.')
  })
})

describe('Hermes import: skills that came with Hermes', () => {
  const ARXIV = skill('arxiv')

  it('leaves out one as Hermes put it, and brings it when the person edited it', () => {
    const root = folder({
      'SOUL.md': 'x',
      'skills/.bundled_manifest': `arxiv:${onlySkill(ARXIV)}\nplan:${onlySkill(skill('plan'))}\n`,
      'skills/research/arxiv/SKILL.md': ARXIV, // as it came
      'skills/plan/SKILL.md': skill('plan', '# plan\n\nMy own way of planning.') // edited
    })
    const p = readHermes(root).profiles[0]!
    expect(p.agent.skills.map((k) => k.name)).toEqual(['plan'])
    expect(p.agent.skills[0]!.body).toContain('My own way of planning.')
    expect(p.agent.notes.join('\n')).toMatch(/1 skill que já vem com o Hermes, sem mudança \(não é sua\)|1 skill that comes with Hermes, unchanged/)
  })

  it('counts a file added to it as an edit, and never opens a credential found there', () => {
    const root = folder({
      'SOUL.md': 'x',
      'skills/.bundled_manifest': `arxiv:${onlySkill(ARXIV)}\nplan:${onlySkill(skill('plan'))}\n`,
      'skills/arxiv/SKILL.md': ARXIV,
      'skills/arxiv/notes.md': 'my notes',
      'skills/plan/SKILL.md': skill('plan'),
      'skills/plan/.env': SECRET
    })
    const read: string[] = []
    const r = readHermes(root, { onRead: (p) => read.push(p) })
    expect(r.profiles[0]!.agent.skills.map((k) => k.name).sort()).toEqual(['arxiv', 'plan'])
    expect(read.some((p) => /\.env$/.test(p))).toBe(false)
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it('without a hash (a v1 manifest) or without a manifest, keeps what it did', () => {
    const v1 = readHermes(folder({ 'SOUL.md': 'x', 'skills/.bundled_manifest': 'arxiv\n', 'skills/arxiv/SKILL.md': skill('arxiv', 'edited') })).profiles[0]!.agent
    expect(v1.skills).toHaveLength(0)
    const none = readHermes(folder({ 'SOUL.md': 'x', 'skills/arxiv/SKILL.md': ARXIV })).profiles[0]!.agent
    expect(none.skills.map((k) => k.name)).toEqual(['arxiv'])
  })

  it('hashes a folder the way Hermes does (a vector from its own dir_hash)', (ctx) => {
    // Python's str(path) uses "\\" on Windows: this vector, made on macOS, holds elsewhere.
    if (process.platform === 'win32') return ctx.skip()
    // tools/skills_sync.py dir_hash on this folder: sorted by path parts (a/ before a-b/), with the
    // __pycache__ left out ("clean") and, for old manifests, kept in ("legacy").
    const files = {
      'skills/arxiv/SKILL.md': '---\nname: arxiv\ndescription: The arxiv recipe.\n---\n# arxiv\n\nDo it well.\n',
      'skills/arxiv/references/a.md': 'refs',
      'skills/arxiv/scripts/run.py': 'print(1)',
      'skills/arxiv/scripts/__pycache__/run.cpython-312.pyc': 'junk',
      'skills/arxiv/a-b/z.md': 'x',
      'skills/arxiv/a/y.md': 'y',
      'SOUL.md': 'x'
    }
    for (const h of ['92ba43b2689b01fb940eb54d045fa49a', '00fb835d24349d1c075d9cb9952c4495']) {
      const r = readHermes(folder({ ...files, 'skills/.bundled_manifest': `arxiv:${h}\n` }))
      expect(r.profiles[0]!.agent.skills).toHaveLength(0)
    }
    const edited = readHermes(folder({ ...files, 'skills/arxiv/a/y.md': 'changed', 'skills/.bundled_manifest': 'arxiv:92ba43b2689b01fb940eb54d045fa49a\n' }))
    expect(edited.profiles[0]!.agent.skills.map((k) => k.name)).toEqual(['arxiv'])
  })
})

describe('Hermes import: many skills', () => {
  it('stops opening skills at the limit, and still counts the rest right', () => {
    const files: Record<string, string> = { 'SOUL.md': 'x', 'skills/.bundled_manifest': 'zz-stock:abc\n', 'skills/zz-stock/SKILL.md': skill('zz-stock') }
    for (let i = 0; i < IMPORT_CAPS.skills + 5; i++) files[`skills/s${String(i).padStart(2, '0')}/SKILL.md`] = skill(`s${String(i).padStart(2, '0')}`)
    const read: string[] = []
    const r = readHermes(folder(files), { onRead: (p) => read.push(p.split('\\').join('/')) })
    const opened = read.filter((p) => p.endsWith('/SKILL.md')).map((p) => p.split('/').slice(-2)[0])
    expect(opened).toHaveLength(IMPORT_CAPS.skills)
    for (let i = IMPORT_CAPS.skills; i < IMPORT_CAPS.skills + 5; i++) expect(opened).not.toContain(`s${i}`)
    expect(opened).not.toContain('zz-stock')
    const a = r.profiles[0]!.agent
    expect(a.skills).toHaveLength(IMPORT_CAPS.skills)
    expect(a.notes.join('\n')).toMatch(/5 skills além de 20|5 skills beyond 20/)
    expect(a.notes.join('\n')).toMatch(/1 skill que já vem com o Hermes, sem mudança \(não é sua\)|1 skill that comes with Hermes, unchanged/)
  })
})

describe('Hermes import: the gateways note', () => {
  it('names only the gateways it had, and Telegram only when it was one', () => {
    const only = gatewaysNote(['Discord'])
    expect(only).toMatch(/Discord/)
    expect(only).not.toMatch(/Telegram/)
    expect(gatewaysNote(['Telegram', 'Discord'])).toMatch(/Telegram se liga|Telegram is turned on/)
    const r = readHermes(folder({ 'SOUL.md': 'x', 'config.yaml': 'discord:\n  require_mention: true\n' }))
    const notes = hermesTeam(r, []).notes.join('\n')
    expect(notes).toMatch(/Discord/)
    expect(notes).not.toMatch(/Telegram/)
  })
})

describe('Hermes import: schedules', () => {
  const now = Date.parse('2026-11-16T12:00:00Z')
  it('maps what fits a routine here', () => {
    expect(hermesSchedule({ kind: 'cron', expr: '0 9 * * *' })).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' })
    expect(hermesSchedule({ kind: 'cron', expr: '15 7 * * mon,wed,FRI' })).toEqual({ days: [1, 3, 5], time: '07:15' })
    expect(hermesSchedule({ kind: 'cron', expr: '0 18 * * 0,7' })).toEqual({ days: [0], time: '18:00' })
    expect(hermesSchedule({ kind: 'cron', expr: '0 9 * * 1-7' })).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' })
    expect(hermesSchedule({ kind: 'cron', expr: '30 8 5 * *' })).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], time: '08:30', monthDay: 5 })
    const once = hermesSchedule({ kind: 'once', run_at: '2026-12-01T14:30:00' }, now)!
    expect(once).toMatchObject({ once: true, date: '2026-12-01', time: '14:30' })
  })
  it('leaves out what does not', () => {
    for (const s of [
      { kind: 'interval', minutes: 30 },
      { kind: 'cron', expr: '*/15 * * * *' },
      { kind: 'cron', expr: '0 9,17 * * *' },
      { kind: 'cron', expr: '0 9 * 1 *' },
      { kind: 'cron', expr: '0 9 1 * 1' },
      { kind: 'cron', expr: '0 0 9 * * *' },
      { kind: 'cron', expr: '0 9 * * 5-1' },
      { kind: 'once', run_at: '2020-01-01T09:00:00Z' },
      { kind: 'nope' }
    ])
      expect(hermesSchedule(s, now)).toBeUndefined()
  })
})

describe('Hermes import: adding it', () => {
  const opts = (personId: string) => ({ defaultLimit: 1000, defaultModel: 'sonnet', works: () => false, personId })

  it('adds an agent with no connector, web and computer off, routines off, memories pending, MCP only named', () => {
    const db = fresh()
    const person = db.people()[0]?.id ?? 'me'
    const r = applyForeignTeam(db, hermesTeam(readHermes(folder(base), { now: Date.parse('2026-11-16T12:00:00Z') }), []), opts(person))
    expect(r.agents).toHaveLength(1)
    const a = db.agent(r.agents[0]!)!
    expect(a).toMatchObject({ name: 'Hermes', handle: 'hermes', instructions: 'You are Hermes, my research partner. Answer in Portuguese.', grants: {}, web: false, computer: false, effort: 'high', modelId: 'sonnet' })
    // Its own model on the Hermes engine wasn't ready here: the summary says which one it had.
    expect(r.summary).toContain('hermes:openrouter/anthropic/claude-opus-4.6')
    const routines = db.routines().filter((x) => x.agentId === a.id)
    expect(routines.map((x) => x.name).sort()).toEqual(['Monthly bill', 'Morning brief'])
    expect(routines.every((x) => !x.enabled)).toBe(true)
    expect(db.skills().filter((k) => k.agents.includes(a.id)).map((k) => k.name).sort()).toEqual(['release-notes', 'weekly-report'])
    const mine = db.memories({ scope: a.id })
    expect(mine.map((m) => m.text)).toEqual(['The repo is eduwxyz/tucano.', 'Run npm test before a PR.'])
    const theirs = db.memories({ scope: personScope(person) }).filter((m) => m.agentId === a.id)
    expect(theirs.map((m) => m.text)).toEqual(['Eduardo prefers small PRs.', 'Eduardo lives in São Paulo.'])
    expect([...mine, ...theirs].every((m) => m.state === 'pending')).toBe(true)
    expect(db.connectors?.() ?? []).toHaveLength(0)
    expect(r.summary).toMatch(/github, notion/)
    expect(r.summary).toMatch(/Telegram/)
    expect(r.summary).toMatch(/Twice a day/)
    expect(r.summary).not.toContain(SECRET)
  })

  it('uses its model on the Hermes engine when that runs here', () => {
    const db = fresh()
    const r = applyForeignTeam(db, hermesTeam(readHermes(folder(base)), []), { ...opts('me'), works: (id) => id.startsWith('hermes:') })
    expect(db.agent(r.agents[0]!)!.modelId).toBe('hermes:openrouter/anthropic/claude-opus-4.6')
  })

  it('imports again without duplicating the agent or the memories about the person', () => {
    const db = fresh()
    const person = db.people()[0]?.id ?? 'me'
    const root = folder(base)
    applyForeignTeam(db, hermesTeam(readHermes(root), []), opts(person))
    const again = applyForeignTeam(db, hermesTeam(readHermes(root), []), opts(person))
    expect(again.agents).toHaveLength(0)
    expect(again.memories).toHaveLength(0)
    expect(db.agents().filter((a) => a.name === 'Hermes')).toHaveLength(1)
  })
})
