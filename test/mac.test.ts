import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Conversation } from '../src/shared/types'
import { systemPrompt } from '../src/core/context'
import { artifactKind, Computers, computerTools, linuxTools, stepFor } from '../src/core/computer'
import { Db } from '../src/core/db'
import { loginEnv, MacComputer, macPath } from '../src/core/mac'
import { systemName } from '../src/core/platform'

const agent = (extra: Partial<Agent> = {}): Agent => ({
  id: 'prod-0001',
  name: 'Produtora',
  handle: 'produtora',
  role: 'Vídeos',
  color: 'rose',
  instructions: '',
  modelId: 'opus',
  effort: 'high',
  limit: 1_000_000,
  used: 0,
  grants: {},
  memory: 'auto',
  computer: true,
  computerKind: 'mac',
  archived: false,
  ...extra
})
const text = (r: { content: unknown[] }): string => (r.content[0] as { text: string }).text
const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

describe('what a shown file is', () => {
  it('videos play in the side panel; code and text open as text', () => {
    expect(['a.mp4', 'b.MOV', 'c.webm', 'd.m4v'].map(artifactKind)).toEqual(['video', 'video', 'video', 'video'])
    expect(artifactKind('falas.py')).toBe('text')
  })
})

describe('paths on the Mac', () => {
  it('resolves ~, absolute and relative paths', () => {
    expect(macPath('~/x/y.txt', '/tmp/w')).toBe(join(homedir(), 'x/y.txt'))
    expect(macPath('/etc/hosts', '/tmp/w')).toBe('/etc/hosts')
    expect(macPath('a/../b.txt', '/tmp/w')).toBe('/tmp/w/b.txt')
  })
})

describe('an agent whose computer is this Mac', () => {
  let db: Db
  let dataDir: string
  let work: string
  let mac: MacComputer
  const ctx = { conversationId: 'c1', messageId: 'm1' }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ad-mac-'))
    db = new Db(join(dataDir, 'test.db'))
    db.saveAgent(agent())
    db.createConversation({ id: 'c1', kind: 'channel', name: 'conteudo', members: ['prod-0001'] })
    mac = new MacComputer({ db, dataDir, emit: () => {}, env: async () => ({ PATH: '/usr/bin:/bin', HOME: homedir(), FROM_SHELL: 'sim' }) })
    mkdirSync(mac.folder('prod-0001'), { recursive: true })
    work = realpathSync(mac.folder('prod-0001'))
  })
  afterEach(async () => {
    await mac.stopAll('prod-0001')
  })

  it('runs commands in its own folder, with the shell environment only', async () => {
    const me = db.agent('prod-0001')!
    process.env['TUCANO_SEGREDO'] = 'nao-pode-vazar'
    const r = await mac.call(me, 'bash', { command: 'pwd; echo "$FROM_SHELL"; echo "x${TUCANO_SEGREDO}x"' }, ctx)
    delete process.env['TUCANO_SEGREDO']
    expect(text(r.result)).toContain(`${work}\nsim\nxx`)
  })

  it('stops a command at its time limit, with its children', async () => {
    const t0 = Date.now()
    const r = await mac.call(db.agent('prod-0001')!, 'bash', { command: 'sleep 30 & sleep 30; echo nunca', timeout_seconds: 1 }, ctx)
    expect(Date.now() - t0).toBeLessThan(8000)
    expect(r.result.isError).toBe(true)
    expect(text(r.result)).toContain('passou de 1 s')
  })

  it('reads, writes and edits real files', async () => {
    const me = db.agent('prod-0001')!
    await mac.call(me, 'write_file', { path: 'falas.py', content: 'FALAS = {"e1": 1}\n' }, ctx)
    expect(readFileSync(join(work, 'falas.py'), 'utf8')).toBe('FALAS = {"e1": 1}\n')
    const ed = await mac.call(me, 'edit_file', { path: join(work, 'falas.py'), old_text: '"e1": 1', new_text: '"e1": 2' }, ctx)
    expect(text(ed.result)).toContain('1 troca')
    expect(text((await mac.call(me, 'read_file', { path: 'falas.py' }, ctx)).result)).toBe('FALAS = {"e1": 2}\n')
    writeFileSync(join(work, 'bin.dat'), Buffer.from([0, 1, 2]))
    expect((await mac.call(me, 'read_file', { path: 'bin.dat' }, ctx)).result.isError).toBe(true)
  })

  it('shows a file in the chat as an artifact', async () => {
    writeFileSync(join(work, 'grade.md'), '# Grade\n')
    const r = await mac.call(db.agent('prod-0001')!, 'show_file', { path: 'grade.md', title: 'A grade' }, ctx)
    expect(r.artifact).toMatchObject({ kind: 'markdown', title: 'A grade', source: join(mac.folder('prod-0001'), 'grade.md') })
    expect(existsSync(join(dataDir, 'artifacts', r.artifact!.id, 'grade.md'))).toBe(true)
  })

  it('an image it shows comes back to it too, so it can check it', async () => {
    writeFileSync(join(work, 'grade.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))
    const r = await mac.call(db.agent('prod-0001')!, 'show_file', { path: 'grade.jpg' }, ctx)
    expect(r.artifact?.kind).toBe('image')
    expect(r.result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64') })
    expect((r.result.content[1] as { text: string }).text).toContain('pra você conferir')
  })

  it('keeps a service running on a Mac port, and stops it with its children', async () => {
    const me = db.agent('prod-0001')!
    const port = await freePort()
    const r = await mac.call(me, 'start_service', { name: 'previa', command: `exec python3 -m http.server ${port} --bind 127.0.0.1`, port }, ctx)
    expect(r.result.isError).toBeFalsy()
    expect(r.service).toBe('previa')
    expect(mac.services('prod-0001')).toMatchObject([{ name: 'previa', running: true, url: `http://127.0.0.1:${port}` }])
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200)
    await mac.call(me, 'stop_service', { name: 'previa' }, ctx)
    expect(mac.services('prod-0001')).toEqual([])
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
    expect(text((await mac.call(me, 'start_service', { name: 'x', command: 'true', port: 47_718 }, ctx)).result)).toContain('não serve')
  })

  it('Computers sends a Mac agent here and never starts a container for it', async () => {
    const computers = new Computers({ db, dataDir, emit: () => {} })
    const me = db.agent('prod-0001')!
    await computers.ensure(me.id) // no docker involved
    expect(computers.info(me)).toMatchObject({ state: 'running', kind: 'mac' })
    const r = await computers.call(me, 'bash', { command: 'pwd' }, ctx)
    expect(text(r.result)).toContain(work)
  })

  it('describes this computer and its system in the tools, the steps and the prompt', () => {
    const me = db.agent('prod-0001')!
    expect(computerTools(me).map((t) => t.name)).toEqual(linuxTools().map((t) => t.name))
    expect(computerTools(me).find((t) => t.name === 'bash')!.description).toContain(`computador do usuário (${systemName()}`)
    expect(computerTools({ computerKind: 'linux' })).toEqual(linuxTools())
    expect(stepFor('read_file', { path: 'falas.py' }, true).detail).toBe('falas.py')
    expect(stepFor('read_file', { path: 'falas.py' }).detail).toBe('/work/falas.py')
    const conv: Conversation = db.conversation('c1')!
    const prompt = systemPrompt({ agent: me, settings: { workspaceName: 'Edu', context: '' }, conversation: conv, peers: [], hasComputer: true, macFolder: work })
    expect(prompt).toContain(`## Seu computador: o computador de Edu (${systemName()})`)
    expect(prompt).toContain(`Eles começam em ${work} (sua pasta de trabalho)`)
    expect(prompt).not.toContain('A pasta de trabalho é /work')
    const off = systemPrompt({ agent: me, settings: { workspaceName: 'Edu', context: '' }, conversation: conv, peers: [], offline: ['Linear'] })
    expect(off).toContain('Você tem acesso a Linear, mas ele está desconectado agora')
  })
})

describe("the user's shell environment", () => {
  it('comes from a clean login shell, without the app process variables', async () => {
    process.env['TUCANO_SEGREDO'] = 'nao-pode-vazar'
    const env = await loginEnv()
    delete process.env['TUCANO_SEGREDO']
    expect(env['PATH']).toContain('/usr/bin')
    expect(env['HOME']).toBe(homedir())
    expect(env['TUCANO_SEGREDO']).toBeUndefined()
  }, 20_000)
})
