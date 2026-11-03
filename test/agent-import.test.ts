import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { applyForeignTeam, hueColor, openBotSchedule, readForeignZip, tucanoSchedule } from '../src/core/agent-import'
import { zipFromBuffer, zipFromFile } from '../src/core/zip'

const fresh = (): Db => new Db(join(mkdtempSync(join(tmpdir(), 'ad-import-')), 'test.db'))

// A small zip writer for the tests: stored or deflated entries, sizes only in the central directory
// (as a streaming writer leaves them), and an optional lie about one entry's size.
function zip(files: Record<string, string | Buffer>, opts: { deflate?: boolean; claim?: Record<string, number> } = {}): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const body = opts.deflate ? deflateRawSync(data) : data
    const n = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(0x808, 6) // utf-8 names, sizes after the data
    local.writeUInt16LE(opts.deflate ? 8 : 0, 8)
    local.writeUInt16LE(n.length, 26)
    locals.push(local, n, body)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(0x808, 8)
    c.writeUInt16LE(opts.deflate ? 8 : 0, 10)
    c.writeUInt32LE(body.length, 20)
    c.writeUInt32LE(opts.claim?.[name] ?? data.length, 24)
    c.writeUInt16LE(n.length, 28)
    c.writeUInt32LE(offset, 42)
    central.push(c, n)
    offset += 30 + n.length + body.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

const lia = {
  key: 'lia',
  name: 'Lia',
  title: 'Pesquisadora',
  description: 'Acha fontes.',
  avatarSeed: 'plush:1',
  avatarHue: 215,
  avatar: 'agents/lia/avatar.png',
  provider: 'claude',
  model: 'claude-opus-5-5',
  reasoningEffort: 'max',
  notifications: true,
  skills: ['agents/lia/skills/fontes'],
  files: 'agents/lia/workspace',
  routines: [
    { key: 'r1', name: 'Resumo do dia', instruction: 'Resuma as notícias.', active: true, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, schedule: { kind: 'weekdays', time: '09:00' } },
    { key: 'r2', name: 'A cada hora', instruction: 'Olhe a caixa.', active: true, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, schedule: { kind: 'hourly', minute: 5 } }
  ],
  memories: [{ text: 'Eduardo prefere fontes primárias.' }, { text: 'Eduardo prefere fontes primárias.' }, { text: 'Responde em português.', inclusion: 'essential' }]
}
const gil = { ...lia, key: 'gil', name: 'Gil', title: 'Grok', description: '', avatar: null, avatarHue: null, provider: 'grok', model: 'grok-4.6', reasoningEffort: 'low', skills: ['agents/gil/skills/fontes'], files: null, routines: [], memories: [] }

const transfer = (agents: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    format: 'openbot-instance-transfer',
    version: 1,
    source: { appVersion: '0.59.0', exportedAt: '2026-11-03T12:00:00Z' },
    agents,
    settings: { mcpServers: [{ id: 'm', name: 'GitHub', transport: 'stdio', enabled: true, command: 'npx', args: [], env: [], envPassthrough: [], workingDirectory: '', url: '', headers: [] }], customProviders: [], customAgents: [], sidebarSections: [], routineFlows: [] },
    shared: null,
    signedIn: ['claude'],
    ...extra
  })

const skill = '---\nname: fontes\ndescription: Ao procurar uma fonte\n---\n\nUse a fonte primária.\n'
const files = (): Record<string, string | Buffer> => ({
  'openbot-transfer.json': transfer([lia, gil]),
  'agents/lia/avatar.png': PNG,
  'agents/lia/skills/fontes/SKILL.md': skill,
  'agents/lia/skills/fontes/check.sh': 'echo oi',
  'agents/lia/workspace/AGENTS.md': '# Lia\n\nSempre cite a fonte.',
  'agents/lia/workspace/notes.txt': 'x',
  'agents/gil/skills/fontes/SKILL.md': skill
})
const opts = { defaultLimit: 2_000_000, defaultModel: 'sonnet' }

describe('importing agents from OpenBot', () => {
  it('brings the agents with no tool, routines off and memories to confirm', () => {
    const db = fresh()
    db.saveAgent({ id: 'x', name: 'Lia', handle: 'lia', role: 'Outra', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'medium', limit: 1, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
    const r = applyForeignTeam(db, readForeignZip(zipFromBuffer(zip(files(), { deflate: true }))), opts)

    const imported = db.agents().filter((a) => a.id !== 'x')
    expect(imported.map((a) => a.handle).sort()).toEqual(['gil', 'lia2'])
    const l = imported.find((a) => a.name === 'Lia')!
    expect(l).toMatchObject({ role: 'Pesquisadora', instructions: '# Lia\n\nSempre cite a fonte.', modelId: 'opus', effort: 'xhigh', grants: {}, computer: false, limit: 2_000_000, customColor: hueColor(215) })
    expect(l.picture).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    const g = imported.find((a) => a.name === 'Gil')!
    expect(g).toMatchObject({ modelId: 'sonnet', effort: 'low', instructions: '' })

    // One skill for both, since it's the same recipe.
    expect(db.skills()).toHaveLength(1)
    expect(db.skills()[0]).toMatchObject({ name: 'fontes', description: 'Ao procurar uma fonte', body: 'Use a fonte primária.' })
    expect(db.skills()[0]!.agents.sort()).toEqual([l.id, g.id].sort())

    // The weekday routine comes in, off, in the agent's DM; the hourly one has no match.
    expect(db.routines()).toHaveLength(1)
    expect(db.routines()[0]).toMatchObject({ name: 'Resumo do dia', enabled: false, schedule: { days: [1, 2, 3, 4, 5], time: '09:00' } })
    expect(db.conversation(db.routines()[0]!.conversationId)).toMatchObject({ kind: 'dm', name: l.id })

    const mems = db.memories({ scope: l.id })
    expect(mems.map((m) => m.text)).toEqual(['Eduardo prefere fontes primárias.', 'Responde em português.'])
    expect(mems.every((m) => m.state === 'pending')).toBe(true)

    expect(r.summary).toContain('Do OpenBot, importei 2 agentes sem nenhum conector liberado, 1 skill, 1 rotina (desligadas), 2 memórias pra você confirmar.')
    expect(r.summary).toContain('Conectores pra adicionar à mão, se quiser: GitHub.')
    expect(r.summary).toContain('a rotina "A cada hora"')
    expect(r.summary).toContain('grok não roda no Tucano')
    expect(r.summary).toContain('1 arquivo da skill fontes além do SKILL.md')
    expect(r.summary).toContain('@gil: as instruções')

    // Again: nothing doubles.
    const again = applyForeignTeam(db, readForeignZip(zipFromBuffer(zip(files()))), opts)
    expect(again.summary).toContain('Nada novo do OpenBot. Já existiam aqui: Lia, Gil.')
    expect(db.agents()).toHaveLength(3)
  })

  it('reads the file from disk the same way', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ad-zip-')), 'export.zip')
    writeFileSync(file, zip(files()))
    const z = zipFromFile(file)
    expect(readForeignZip(z).agents.map((a) => a.name)).toEqual(['Lia', 'Gil'])
    z.close()
  })

  it('keeps out paths outside the agent, and a skill named like one already here', () => {
    const db = fresh()
    db.saveSkill({ id: 'k', name: 'fontes', description: 'minha', body: 'minha receita', agents: [], state: 'active', createdAt: 1, updatedAt: 1 })
    const sneaky = { ...lia, avatar: 'agents/lia/../../etc/passwd.png', files: 'agents/other/workspace', skills: ['agents/lia/skills/fontes', '/etc/skills/x'] }
    const r = applyForeignTeam(db, readForeignZip(zipFromBuffer(zip({ ...files(), 'openbot-transfer.json': transfer([sneaky]), 'agents/other/workspace/AGENTS.md': 'not hers' }))), opts)
    const a = db.agents()[0]!
    expect(a.picture).toBeUndefined()
    expect(a.instructions).toBe('Acha fontes.')
    // Her skill comes under another name; mine stays as it was.
    expect(db.skills().map((k) => k.name).sort()).toEqual(['fontes', 'fontes-lia'])
    expect(db.skill('k')).toMatchObject({ body: 'minha receita', agents: [] })
    expect(r.summary).toContain('1 skill')
  })

  it('refuses what is not an OpenBot export, a newer version and an entry that unpacks too big', () => {
    expect(() => readForeignZip(zipFromBuffer(zip({ 'a.txt': 'x' })))).toThrow('Não reconheci esse .zip')
    expect(() => readForeignZip(zipFromBuffer(zip({ 'openbot-import.json': '{}' })))).toThrow('Grok Bot')
    expect(() => readForeignZip(zipFromBuffer(zip({ 'openbot-transfer.json': transfer([], { version: 2 }) })))).toThrow('versão do OpenBot')
    expect(() => readForeignZip(zipFromBuffer(zip({ 'openbot-transfer.json': '{nope' })))).toThrow('corrompido')
    expect(() => zipFromBuffer(Buffer.from('not a zip at all, just text'))).toThrow('corrompido')
    const bomb = zip({ ...files(), 'openbot-transfer.json': transfer([lia]) }, { deflate: true, claim: { 'agents/lia/workspace/AGENTS.md': 50_000_000 } })
    // The instructions are over the cap, so that agent is reported, not read.
    const team = readForeignZip(zipFromBuffer(bomb))
    expect(team.agents).toHaveLength(0)
    expect(team.notes[0]).toContain('agente nº 1')
  })

  it('turns schedules into the ones Tucano runs', () => {
    expect(openBotSchedule({ kind: 'daily', time: '07:30' })).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], time: '07:30' })
    expect(openBotSchedule({ kind: 'weekly', weekday: 0, time: '18:00' })).toEqual({ days: [0], time: '18:00' })
    expect(openBotSchedule({ kind: 'advanced', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], days: { kind: 'days-of-week', days: [5, 1] }, time: { kind: 'at-time', time: '10:00' } })).toEqual({ days: [1, 5], time: '10:00' })
    expect(openBotSchedule({ kind: 'advanced', months: [1], days: { kind: 'every-day' }, time: { kind: 'at-time', time: '10:00' } })).toBeUndefined()
    expect(openBotSchedule({ kind: 'monthly', day: 1, time: '10:00' })).toBeUndefined()
    expect(openBotSchedule({ kind: 'custom', expression: '* * * * *' })).toBeUndefined()
    const soon = new Date(Date.now() + 2 * 86_400_000)
    const date = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`
    expect(openBotSchedule({ kind: 'once', date, time: '12:00' })).toEqual({ days: [soon.getDay()], time: '12:00', once: true })
    expect(openBotSchedule({ kind: 'once', date: '2020-01-01', time: '12:00' })).toBeUndefined()
    expect(hueColor(0)).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('importing agents from Grok Bot, through our skill', () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const manifest = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      format: 'tucano-agent-import',
      version: 1,
      source: 'grok-bot',
      agents: [
        {
          key: 'research',
          name: 'Research',
          role: 'Market research',
          instructions: 'You look for primary sources.',
          picture: 'agents/research/picture.png',
          skills: ['agents/research/skills/brief'],
          routines: [
            { name: 'Morning news', prompt: 'Summarize the news.', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '08:30', timezone: zone },
            { name: 'Every hour', prompt: 'Check the inbox.', days: [], time: '00:00' }
          ],
          memories: ['The user wants reports in BRL.', 'The user wants reports in BRL.']
        },
        { key: 'sales', name: 'Sales', role: 'Outbound', instructions: '', routines: [], memories: [] },
        { key: 'sales', name: 'Twin', instructions: 'same key' },
        { key: 'Bad Key', name: 'Nope', instructions: 'x' }
      ],
      channels: [
        { name: 'Market Desk', topic: 'Weekly review', members: ['research', 'sales', 'ghost'], routines: [{ name: 'Friday' }] },
        { name: 'geral', members: ['sales'] }
      ],
      ...extra
    })
  const files = (): Record<string, string | Buffer> => ({
    'tucano-import.json': manifest(),
    'agents/research/picture.png': PNG,
    'agents/research/skills/brief/SKILL.md': '---\nname: brief\ndescription: When writing a brief\n---\n\nKeep it short.\n',
    'agents/research/skills/brief/template.txt': 'x'
  })

  it('brings agents, skills, routines off, memories to confirm and group chats as channels', () => {
    const db = fresh()
    db.createConversation({ id: 'g', kind: 'channel', name: 'geral', members: [] })
    const r = applyForeignTeam(db, readForeignZip(zipFromBuffer(zip(files(), { deflate: true }))), opts)

    expect(db.agents().map((a) => a.handle).sort()).toEqual(['research', 'sales'])
    const res = db.agents().find((a) => a.handle === 'research')!
    const sal = db.agents().find((a) => a.handle === 'sales')!
    expect(res).toMatchObject({ name: 'Research', role: 'Market research', instructions: 'You look for primary sources.', modelId: 'sonnet', effort: 'medium', grants: {}, computer: false })
    expect(res.picture).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(db.skills().map((k) => [k.name, k.body, k.agents])).toEqual([['brief', 'Keep it short.', [res.id]]])

    expect(db.routines()).toHaveLength(1)
    expect(db.routines()[0]).toMatchObject({ name: 'Morning news', enabled: false, schedule: { days: [1, 2, 3, 4, 5], time: '08:30' } })
    expect(db.memories({ scope: res.id }).map((m) => [m.text, m.state])).toEqual([['The user wants reports in BRL.', 'pending']])

    // A new channel with both, and the one already here gets the agent it was missing.
    const desk = db.conversations().find((c) => c.kind === 'channel' && c.name === 'market-desk')!
    expect(desk).toMatchObject({ topic: 'Weekly review' })
    expect(desk.members.sort()).toEqual([res.id, sal.id].sort())
    expect(db.conversation('g')!.members).toEqual([sal.id])

    expect(r.summary).toContain('Do Grok Bot, importei 2 agentes sem nenhum conector liberado, 1 skill, 1 canal, 1 rotina (desligadas), 1 memória pra você confirmar.')
    expect(r.summary).toContain('o modelo do Grok Bot (ficou o modelo padrão)')
    expect(r.summary).toContain('a rotina "Every hour"')
    expect(r.summary).toContain('@sales: as instruções')
    expect(r.summary).toContain('as rotinas do canal #market-desk')
    expect(r.summary).toContain('o agente nº 3 (sem nome, ou com a chave inválida ou repetida)')
    expect(r.summary).toContain('o agente nº 4')
    expect(r.summary).toContain('1 arquivo da skill brief além do SKILL.md')

    // Again: nothing doubles, and the channel keeps its two.
    const again = applyForeignTeam(db, readForeignZip(zipFromBuffer(zip(files()))), opts)
    expect(again.summary).toContain('Nada novo do Grok Bot. Já existiam aqui: Research, Sales.')
    expect(db.conversations().filter((c) => c.kind === 'channel')).toHaveLength(2)
    expect(db.conversation(desk.id)!.members).toHaveLength(2)
  })

  it('reads the example in the skill we hand to Grok Bot', () => {
    const skill = readFileSync(join(__dirname, '../src/renderer/src/assets/tucano-export-skill.md'), 'utf8')
    const example = skill.split('## tucano-import.json')[1]!.split('```json')[1]!.split('```')[0]!
    const team = readForeignZip(zipFromBuffer(zip({ 'tucano-import.json': example })))
    expect(team.source).toBe('Grok Bot')
    expect(team.agents.map((a) => [a.key, a.name, a.routines.length, a.memories.length])).toEqual([['research', 'Research', 1, 1]])
    expect(team.channels).toEqual([{ name: 'market-desk', topic: 'Weekly competitor review', members: ['research'] }])
  })

  it('refuses another format or a newer version', () => {
    expect(() => readForeignZip(zipFromBuffer(zip({ 'tucano-import.json': manifest({ version: 2 }) })))).toThrow('versão mais nova')
    expect(() => readForeignZip(zipFromBuffer(zip({ 'tucano-import.json': manifest({ format: 'x' }) })))).toThrow('não é uma exportação pro Tucano')
    expect(() => readForeignZip(zipFromBuffer(zip({ 'tucano-import.json': '[' })))).toThrow('corrompido')
  })

  it('reads day names and times', () => {
    expect(tucanoSchedule({ days: ['Sun', 'sat', 'sun'], time: '18:00' })).toEqual({ days: [0, 6], time: '18:00' })
    expect(tucanoSchedule({ days: ['fri'], time: '09:15', once: true })).toEqual({ days: [5], time: '09:15', once: true })
    expect(tucanoSchedule({ days: ['someday'], time: '09:15' })).toBeUndefined()
    expect(tucanoSchedule({ days: ['mon'], time: '25:00' })).toBeUndefined()
    expect(tucanoSchedule({ days: [], time: '09:00' })).toBeUndefined()
  })
})
