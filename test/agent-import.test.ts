import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { applyForeignTeam, hueColor, IMPORT_CAPS, openBotSchedule, readForeignZip, tucanoSchedule } from '../src/core/agent-import'
import { extractZip, zipFromBuffer, zipFromFile } from '../src/core/zip'

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
    expect(l).toMatchObject({ role: 'Pesquisadora', instructions: '# Lia\n\nSempre cite a fonte.', modelId: 'opus', effort: 'xhigh', grants: {}, computer: false, web: false, limit: 2_000_000, customColor: hueColor(215) })
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

    expect(r.summary).toContain('Do OpenBot, importei 2 agentes sem nenhum conector e com a busca na web desligada, 1 skill, 1 rotina (desligadas), 2 memórias pra você confirmar.')
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
    // The instructions are over the cap: only they stay out, and the agent comes with its description.
    const team = readForeignZip(zipFromBuffer(bomb))
    expect(team.agents).toHaveLength(1)
    expect(team.agents[0]).toMatchObject({ instructions: 'Acha fontes.', skills: [{ name: 'fontes' }] })
    expect(team.agents[0]!.notes).toContain("o AGENTS.md (não deu pra ler)")
  })

  it('drops only the part that cannot be read, not the agent', () => {
    const bad = zip({ ...files(), 'openbot-transfer.json': transfer([lia]) }, { deflate: true, claim: { 'agents/lia/skills/fontes/SKILL.md': 50_000_000, 'agents/lia/avatar.png': 50_000_000 } })
    const [a] = readForeignZip(zipFromBuffer(bad)).agents
    expect(a).toMatchObject({ name: 'Lia', instructions: '# Lia\n\nSempre cite a fonte.', skills: [], picture: undefined })
    expect(a!.notes).toEqual(expect.arrayContaining(['a skill fontes (não deu pra ler)', 'a foto (grande demais)']))
  })

  it('keeps a Gemini agent on Gemini, and moves a model whose CLI is not ready to one that is', () => {
    const gem = { ...gil, key: 'gem', name: 'Gem', provider: 'antigravity', model: 'gemini-3-pro', skills: [] }
    const cur = { ...gil, key: 'cur', name: 'Cur', provider: 'cursor', model: 'composer-2', skills: [] }
    const db = fresh()
    const r = applyForeignTeam(db, readForeignZip(zipFromBuffer(zip({ 'openbot-transfer.json': transfer([gem, cur]) }))), { ...opts, defaultModel: 'antigravity:gemini-3-pro', works: (id) => id.startsWith('antigravity:') })
    expect(db.agents().map((a) => [a.name, a.modelId])).toEqual([['Gem', 'antigravity:gemini-3-pro'], ['Cur', 'antigravity:gemini-3-pro']])
    expect(r.summary).not.toContain('não roda no Tucano')
    expect(r.summary).toContain('@cur: o modelo cursor:composer-2 (o CLI dele não está pronto aqui: ficou antigravity:gemini-3-pro)')
  })

  it('brings at most so many agents, memories and routines, and says how many stayed out', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      ...gil,
      key: `a${i}`,
      name: `A${i}`,
      skills: [],
      memories: Array.from({ length: i === 0 ? 5000 : 1 }, (_, j) => ({ text: `fato ${j}` })),
      routines: Array.from({ length: i === 0 ? 2000 : 0 }, (_, j) => ({ name: `r${j}`, instruction: 'x', schedule: { kind: 'daily', time: '09:00' } }))
    }))
    const db = fresh()
    const r = applyForeignTeam(db, readForeignZip(zipFromBuffer(zip({ 'openbot-transfer.json': transfer(many) }))), opts)
    expect(db.agents()).toHaveLength(IMPORT_CAPS.agents)
    const first = db.agents().find((a) => a.name === 'A0')!
    expect(db.memories({ scope: first.id })).toHaveLength(IMPORT_CAPS.memories)
    expect(db.routines().filter((x) => x.agentId === first.id)).toHaveLength(IMPORT_CAPS.routines)
    expect(r.summary).toContain(`260 agentes além de ${IMPORT_CAPS.agents}`)
    expect(r.summary).toContain(`4960 memórias além de ${IMPORT_CAPS.memories}`)
    expect(r.summary).toContain(`1980 rotinas além de ${IMPORT_CAPS.routines}`)
    expect(r.summary).toContain('• e mais')
    expect(r.summary.length).toBeLessThan(6_000)
  })

  it('turns schedules into the ones Tucano runs', () => {
    expect(openBotSchedule({ kind: 'daily', time: '07:30' })).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], time: '07:30' })
    expect(openBotSchedule({ kind: 'weekly', weekday: 0, time: '18:00' })).toEqual({ days: [0], time: '18:00' })
    expect(openBotSchedule({ kind: 'advanced', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], days: { kind: 'days-of-week', days: [5, 1] }, time: { kind: 'at-time', time: '10:00' } })).toEqual({ days: [1, 5], time: '10:00' })
    expect(openBotSchedule({ kind: 'advanced', months: [1], days: { kind: 'every-day' }, time: { kind: 'at-time', time: '10:00' } })).toBeUndefined()
    expect(openBotSchedule({ kind: 'monthly', day: 1, time: '10:00' })).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], time: '10:00', monthDay: 1 })
    expect(openBotSchedule({ kind: 'monthly', day: 40, time: '10:00' })).toBeUndefined()
    expect(openBotSchedule({ kind: 'custom', expression: '* * * * *' })).toBeUndefined()
    const soon = new Date(Date.now() + 2 * 86_400_000)
    const date = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`
    expect(openBotSchedule({ kind: 'once', date, time: '12:00' })).toEqual({ days: [soon.getDay()], time: '12:00', once: true, date })
    // Weeks ahead too, on that date (it used to be dropped past the coming week).
    const later = new Date(Date.now() + 40 * 86_400_000)
    const far = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, '0')}-${String(later.getDate()).padStart(2, '0')}`
    expect(openBotSchedule({ kind: 'once', date: far, time: '12:00' })).toMatchObject({ once: true, date: far })
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
          key: 'ledger',
          name: 'Ledger',
          role: 'Bookkeeping',
          instructions: 'You match invoices.',
          picture: 'agents/ledger/picture.png',
          skills: ['agents/ledger/skills/reconcile'],
          routines: [
            { name: 'Unpaid invoices', prompt: 'List unpaid invoices.', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '08:30', timezone: zone },
            { name: 'Every hour', prompt: 'Check the inbox.', days: [], time: '00:00' }
          ],
          memories: ['Invoice numbers look like INV-2026-0042.', 'Invoice numbers look like INV-2026-0042.']
        },
        { key: 'sales', name: 'Sales', role: 'Outbound', instructions: '', routines: [], memories: [] },
        { key: 'sales', name: 'Twin', instructions: 'same key' },
        { key: 'Bad Key', name: 'Nope', instructions: 'x' }
      ],
      channels: [
        { name: 'Finance Room', topic: 'Invoices and payments', members: ['ledger', 'sales', 'ghost'], routines: [{ name: 'Friday' }] },
        { name: 'geral', members: ['sales'] }
      ],
      ...extra
    })
  const files = (): Record<string, string | Buffer> => ({
    'tucano-import.json': manifest(),
    'agents/ledger/picture.png': PNG,
    'agents/ledger/skills/reconcile/SKILL.md': '---\nname: reconcile\ndescription: When reconciling\n---\n\nKeep it short.\n',
    'agents/ledger/skills/reconcile/template.txt': 'x'
  })

  it('imports instructions over the recommendation exactly from Tucano exports', () => {
    const instructions = ` ${'x'.repeat(32_000)} END\n`
    const source = files()
    source['tucano-import.json'] = manifest({ agents: [{ key: 'ledger', name: 'Ledger', instructions }] })
    expect(readForeignZip(zipFromBuffer(zip(source))).agents[0]?.instructions).toBe(instructions)
  })

  it('imports OpenBot instructions over the recommendation whole', () => {
    const instructions = ` ${'x'.repeat(40_000)} END\n`
    const source = files()
    source['agents/lia/workspace/AGENTS.md'] = instructions
    source['openbot-transfer.json'] = transfer([{ ...lia, description: 'Fallback description', files: 'agents/lia/workspace' }])
    const team = readForeignZip(zipFromBuffer(zip(source, { deflate: true })))
    expect(team.agents[0]?.instructions).toHaveLength(instructions.length)
    expect(team.agents[0]?.instructions).toMatch(/^ x{10,} END\n$/)
    expect(team.agents[0]?.notes).not.toContain('o AGENTS.md (não deu pra ler)')
  })

  it('reports when imported instructions exceed the recommendation, without shortening them', () => {
    const instructions = `${'x'.repeat(32_000)} END`
    const source = files()
    source['tucano-import.json'] = manifest({ agents: [{ key: 'ledger', name: 'Ledger', instructions }] })
    const result = applyForeignTeam(fresh(), readForeignZip(zipFromBuffer(zip(source))), opts)
    expect(result.summary).toContain('Prompt longo')
    expect(result.summary).toContain('32.004')
  })

  it('imports long skills whole and reports how far they exceed the recommendation', () => {
    const source = files()
    const body = 'x'.repeat(32_345)
    source['agents/ledger/skills/reconcile/SKILL.md'] = `---\nname: reconcile\ndescription: When reconciling\n---\n${body}`
    const db = fresh()
    const team = readForeignZip(zipFromBuffer(zip(source)))
    const r = applyForeignTeam(db, team, opts)
    expect(db.skills()[0]?.body).toHaveLength(32_345)
    expect(r.summary).toContain('22.345 acima do recomendado de 10.000')
  })

  it('brings agents, skills, routines off, memories to confirm and group chats as channels', () => {
    const db = fresh()
    db.createConversation({ id: 'g', kind: 'channel', name: 'geral', members: [] })
    const r = applyForeignTeam(db, readForeignZip(zipFromBuffer(zip(files(), { deflate: true }))), opts)

    expect(db.agents().map((a) => a.handle).sort()).toEqual(['ledger', 'sales'])
    const res = db.agents().find((a) => a.handle === 'ledger')!
    const sal = db.agents().find((a) => a.handle === 'sales')!
    expect(res).toMatchObject({ name: 'Ledger', role: 'Bookkeeping', instructions: 'You match invoices.', modelId: 'sonnet', effort: 'medium', grants: {}, computer: false, web: false })
    expect(res.picture).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(db.skills().map((k) => [k.name, k.body, k.agents])).toEqual([['reconcile', 'Keep it short.', [res.id]]])

    expect(db.routines()).toHaveLength(1)
    expect(db.routines()[0]).toMatchObject({ name: 'Unpaid invoices', enabled: false, schedule: { days: [1, 2, 3, 4, 5], time: '08:30' } })
    expect(db.memories({ scope: res.id }).map((m) => [m.text, m.state])).toEqual([['Invoice numbers look like INV-2026-0042.', 'pending']])

    // A new channel with both. The #geral already here stays as it was: Sales goes into a new #geral-2.
    const desk = db.conversations().find((c) => c.kind === 'channel' && c.name === 'finance-room')!
    expect(desk).toMatchObject({ topic: 'Invoices and payments' })
    expect(desk.members.sort()).toEqual([res.id, sal.id].sort())
    expect(db.conversation('g')!.members).toEqual([])
    expect(db.conversations().find((c) => c.name === 'geral-2')!.members).toEqual([sal.id])
    expect(r.summary).toContain('o canal #geral já existia: os agentes entraram no #geral-2, novo')

    expect(r.summary).toContain('Do Grok Bot, importei 2 agentes sem nenhum conector e com a busca na web desligada, 1 skill, 2 canais, 1 rotina (desligadas), 1 memória pra você confirmar.')
    expect(r.summary).toContain('o modelo do Grok Bot (ficou o modelo padrão)')
    expect(r.summary).toContain('a rotina "Every hour"')
    expect(r.summary).toContain('@sales: as instruções')
    expect(r.summary).toContain('as rotinas do canal #finance-room')
    expect(r.summary).toContain('o agente nº 3 (sem nome, ou com a chave inválida ou repetida)')
    expect(r.summary).toContain('o agente nº 4')
    expect(r.summary).toContain('1 arquivo da skill reconcile além do SKILL.md')

    // Again: nothing doubles, and the channel keeps its two.
    const again = applyForeignTeam(db, readForeignZip(zipFromBuffer(zip(files()))), opts)
    expect(again.summary).toContain('Nada novo do Grok Bot. Já existiam aqui: Ledger, Sales.')
    expect(db.conversations().filter((c) => c.kind === 'channel')).toHaveLength(3)
    expect(db.conversation(desk.id)!.members).toHaveLength(2)
  })

  it('never puts an imported agent in a channel I already have', () => {
    const db = fresh()
    db.saveAgent({ id: 'me1', name: 'Bento', handle: 'bento', role: 'Mantenedor', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'medium', limit: 1, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
    db.createConversation({ id: 't', kind: 'channel', name: 'tucano', members: ['me1'] })
    const spy = JSON.stringify({ format: 'tucano-agent-import', version: 1, source: 'grok-bot', agents: [{ key: 'spy', name: 'Spy', instructions: 'Read everything.' }], channels: [{ name: 'tucano', members: ['spy'] }] })
    const r = applyForeignTeam(db, readForeignZip(zipFromBuffer(zip({ 'tucano-import.json': spy }))), opts)
    const s = db.agents().find((a) => a.name === 'Spy')!
    expect(db.conversation('t')!.members).toEqual(['me1'])
    expect(db.conversations().find((c) => c.name === 'tucano-2')!.members).toEqual([s.id])
    expect(r.summary).toContain('o canal #tucano já existia')
    // Again: the same #tucano-2, not a third.
    applyForeignTeam(db, readForeignZip(zipFromBuffer(zip({ 'tucano-import.json': spy }))), opts)
    expect(db.conversations().filter((c) => c.kind === 'channel').map((c) => c.name).sort()).toEqual(['tucano', 'tucano-2'])
  })

  it('puts only the agents made by this import in its channels', () => {
    const db = fresh()
    const base = { color: 'sky' as const, modelId: 'sonnet', effort: 'medium' as const, limit: 1, used: 0, memory: 'auto' as const, computer: false, archived: false }
    db.saveAgent({ ...base, id: 'tuca', name: 'Tuca', handle: 'tuca', role: 'Monta o time', instructions: 'Você cria agentes.', grants: {} })
    db.saveAgent({ ...base, id: 'me1', name: 'Bento', handle: 'bento', role: 'Mantenedor', instructions: 'Cuida do código.', grants: { github: 'write' } as never })
    // A file with copies of both (their instructions are public) and a stranger, all in one group chat.
    const file = JSON.stringify({
      format: 'tucano-agent-import', version: 1, source: 'grok-bot',
      agents: [
        { key: 't', name: 'Tuca', role: 'Monta o time', instructions: 'Você cria agentes.' },
        { key: 'b', name: 'Bento', role: 'Mantenedor', instructions: 'Cuida do código.' },
        { key: 'spy', name: 'Spy', instructions: 'Read everything.' }
      ],
      channels: [{ name: 'sala', members: ['t', 'b', 'spy'] }, { name: 'so-eles', members: ['t', 'b'] }]
    })
    const r = applyForeignTeam(db, readForeignZip(zipFromBuffer(zip({ 'tucano-import.json': file }))), opts)
    const spy = db.agents().find((a) => a.name === 'Spy')!
    expect(db.conversations().find((c) => c.name === 'sala')!.members).toEqual([spy.id])
    // A channel with only agents that were already here isn't made at all.
    expect(db.conversations().some((c) => c.name === 'so-eles')).toBe(false)
    expect(r.summary).toContain('Já existiam aqui: Tuca, Bento.')
    expect(r.summary).toContain('#sala: Tuca, Bento já estavam aqui e não entraram (só os agentes importados agora entram)')
    expect(r.summary).toContain('1 canal')
    // Again: nothing new, no channel, no one added anywhere.
    const again = applyForeignTeam(db, readForeignZip(zipFromBuffer(zip({ 'tucano-import.json': file }))), opts)
    expect(again.summary).toContain('Nada novo do Grok Bot.')
    expect(db.conversations().filter((c) => c.kind === 'channel').map((c) => [c.name, c.members])).toEqual([['sala', [spy.id]]])
  })

  it('reads the example in the skill we hand to Grok Bot', () => {
    const skill = readFileSync(join(__dirname, '../src/renderer/src/assets/tucano-export-skill.md'), 'utf8')
    const example = skill.split('```json')[1]!.split('```')[0]!
    const team = readForeignZip(zipFromBuffer(zip({ 'tucano-import.json': example })))
    expect(team.source).toBe('Grok Bot')
    expect(team.agents.map((a) => [a.key, a.name, a.routines.length, a.memories.length])).toEqual([['ledger', 'Ledger', 1, 1]])
    expect(team.agents[0]!.routines[0]).toMatchObject({ name: 'Unpaid invoices', schedule: { days: [1], time: '17:15' } })
    expect(team.channels).toEqual([{ name: 'finance-room', topic: 'Invoices and payments', members: ['ledger'] }])
    // The limits the skill asks for are the ones the importer keeps.
    expect(skill).toContain(`**Agents** (${IMPORT_CAPS.agents} at most)`)
    expect(skill).toContain(`(${IMPORT_CAPS.skills} at most per agent)`)
    expect(skill).toContain(`(${IMPORT_CAPS.routines} at most per agent)`)
    expect(skill).toContain(`up to 300 characters and ${IMPORT_CAPS.memories} per agent`)
    expect(skill).toContain(`**Group chats** (${IMPORT_CAPS.channels} at most)`)
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

describe('a vault sent to a server as a .zip', () => {
  it('unpacks it, the zipped folder as the root, without the Mac’s extras', () => {
    const to = mkdtempSync(join(tmpdir(), 'tucano-unzip-'))
    const z = zipFromBuffer(zip({ 'Cofre/Pessoas/Ana.md': '# Ana', 'Cofre/img/foto.png': Buffer.from([1, 2, 3]), '__MACOSX/Cofre/._Ana.md': 'x', 'Cofre/.DS_Store': 'x' }, { deflate: true }))
    const root = extractZip(z, to)
    expect(root).toBe(join(to, 'Cofre'))
    expect(readFileSync(join(root, 'Pessoas', 'Ana.md'), 'utf8')).toBe('# Ana')
    expect(readFileSync(join(root, 'img', 'foto.png'))).toEqual(Buffer.from([1, 2, 3]))
    expect(existsSync(join(to, '__MACOSX'))).toBe(false)
    expect(existsSync(join(root, '.DS_Store'))).toBe(false)
  })

  it('refuses a path that would land outside, and one too big', () => {
    for (const name of ['../fora.md', 'a/../../fora.md', '/etc/x.md', 'C:/x.md'])
      expect(() => extractZip(zipFromBuffer(zip({ [name]: 'x' })), mkdtempSync(join(tmpdir(), 'tucano-unzip-'))), name).toThrow()
    expect(() => extractZip(zipFromBuffer(zip({ 'a.md': 'x'.repeat(100) })), mkdtempSync(join(tmpdir(), 'tucano-unzip-')), { file: 10, total: 1000 })).toThrow()
    expect(() => extractZip(zipFromBuffer(zip({ 'a.md': 'x'.repeat(60), 'b.md': 'x'.repeat(60) })), mkdtempSync(join(tmpdir(), 'tucano-unzip-')), { file: 100, total: 100 })).toThrow()
  })
})
