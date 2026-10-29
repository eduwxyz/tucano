import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import { artifactKind, checkFolder, clipOutput, Computers, containerPath, folderName, formatExec, hostUrl, listening, mountArgs } from '../src/core/computer'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

describe('helpers', () => {
  it('clips long output keeping the end', () => {
    const out = clipOutput('a'.repeat(100) + 'FIM', 50)
    expect(out.length).toBeLessThan(120)
    expect(out.endsWith('FIM')).toBe(true)
    expect(out).toContain('cortados')
  })

  it('formats a command result, and says when it timed out', () => {
    expect(formatExec({ code: 0, stdout: 'oi\n', stderr: '' }, 120)).toBe('exit code 0\n--- stdout ---\noi')
    expect(formatExec({ code: 124, stdout: '', stderr: '' }, 5)).toContain('passou de 5 s')
    expect(formatExec({ code: 1, stdout: '', stderr: '\u001b[31merro\u001b[0m' }, 5)).toBe('exit code 1\n--- stderr ---\nerro')
  })

  it('resolves paths inside the computer', () => {
    expect(containerPath('app/index.js')).toBe('/work/app/index.js')
    expect(containerPath('/work/../etc/passwd')).toBe('/etc/passwd')
  })

  it('reads listening sockets from /proc/net/tcp', () => {
    const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
    const all = `${header}   0: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1`
    const loop = `${header}   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1`
    const conn = `${header}   0: 0100007F:1F40 0100007F:A000 01 00000000:00000000 00:00000000 00000000     0        0 1`
    expect(listening(all, 8000)).toBe('all')
    expect(listening(loop, 8080)).toBe('loopback')
    expect(listening(conn, 8000)).toBeNull() // established, not listening
    expect(listening(`${header}   0: 00000000000000000000000000000000:1538 00000000000000000000000000000000:0000 0A 0`, 5432)).toBe('all')
  })

  it('maps localhost URLs to the ports published on the Mac', () => {
    expect(hostUrl('http://localhost:5173/dash?x=1', { 5173: 55001 })).toBe('http://127.0.0.1:55001/dash?x=1')
    expect(hostUrl('https://example.com/', {})).toBe('https://example.com/')
    expect(hostUrl('http://localhost:9999', { 5173: 1 })).toHaveProperty('error')
    expect(hostUrl('file:///etc/passwd', {})).toHaveProperty('error')
  })

  it('knows how to show each kind of file', () => {
    expect(artifactKind('print.PNG')).toBe('image')
    expect(artifactKind('relatorio.md')).toBe('markdown')
    expect(artifactKind('vendas.csv')).toBe('csv')
    expect(artifactKind('app.zip')).toBe('file')
  })
})

describe('lent folders', () => {
  it('lends only project folders inside home: not home itself, Library, hidden folders or the app data', () => {
    const home = mkdtempSync(join(tmpdir(), 'ad-home-'))
    for (const d of ['projetos/app/.dados', 'Library/Keychains', '.ssh', 'Library/Application Support/Tucano']) mkdirSync(join(home, d), { recursive: true })
    writeFileSync(join(home, 'arquivo.txt'), '')
    const dataDir = join(home, 'Library/Application Support/Tucano')
    const check = (p: string): string | null => checkFolder(join(home, p), { home, dataDir })
    expect(check('projetos/app')).toBeNull()
    expect(check('')).toMatch(/dentro da sua pasta/)
    expect(check('Library/Keychains')).toMatch(/credenciais/)
    expect(check('.ssh')).toMatch(/credenciais/)
    expect(check('arquivo.txt')).toMatch(/não é uma pasta/)
    expect(check('nada')).toMatch(/não existe/)
    expect(checkFolder(tmpdir(), { home, dataDir })).toMatch(/dentro da sua pasta/)
    expect(checkFolder(join(home, 'projetos'), { home, dataDir: join(home, 'projetos/app/.dados') })).toMatch(/dados do próprio/)
  })

  it('names each folder after itself, safely and without repeats', () => {
    expect(folderName('/Users/edu/Documents/Meu Projeto', [])).toBe('meu-projeto')
    expect(folderName('/Users/edu/a/app', ['app'])).toBe('app-2')
    expect(folderName('/Users/edu/.coisa', [])).toBe('coisa')
  })

  it("gives Linux its own node_modules and .venv, never the Mac's, and mounts read-only when asked", () => {
    const has = (p: string): boolean => p.endsWith('/py/.venv')
    expect(mountArgs('c', [{ name: 'app', path: '/m/app', readOnly: false }], has)).toEqual(['-v', '/m/app:/projetos/app', '-v', 'c-app-node_modules:/projetos/app/node_modules'])
    expect(mountArgs('c', [{ name: 'py', path: '/m/py', readOnly: false }], has)).toContain('c-py-venv:/projetos/py/.venv')
    expect(mountArgs('c', [{ name: 'ro', path: '/m/ro', readOnly: true }], has)).toEqual(['-v', '/m/ro:/projetos/ro:ro'])
  })
})

// The rest needs Docker running and the base image; skipped otherwise.
const hasDocker = ((): boolean => {
  try {
    execFileSync('docker', ['image', 'inspect', 'node:22-bookworm'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!hasDocker)('computer (Docker)', () => {
  const ready = { installed: true, loggedIn: true }
  const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  const agent = (id: string, handle: string, computer: boolean): Agent => ({
    id, name: handle, handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer, archived: false
  })
  const ctx = { conversationId: 'd1', messageId: 'm1' }
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  let dataDir: string
  let db: Db
  let computers: Computers
  let lia: Agent
  const shots: string[] = []

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ad-computer-'))
    db = new Db(join(dataDir, 'test.db'))
    lia = agent('c0ffee00-0000-4000-8000-000000000001', 'lia', true)
    db.saveAgent(lia)
    db.saveAgent(agent('c0ffee00-0000-4000-8000-000000000002', 'theo', false))
    db.createConversation({ id: 'd1', kind: 'dm', name: lia.id, members: [lia.id] })
    db.createConversation({ id: 'd2', kind: 'dm', name: 'c0ffee00-0000-4000-8000-000000000002', members: ['c0ffee00-0000-4000-8000-000000000002'] })
    computers = new Computers({ db, dataDir, emit: () => {}, shoot: async (o) => (shots.push(o.url), PNG) })
    await computers.ensure(lia.id)
  }, 300_000)

  afterAll(async () => {
    await computers?.erase(lia.id)
  }, 60_000)

  const run = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
    const out = await computers.call(lia, name, args, ctx)
    const text = out.result.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
    return { text, isError: !!out.result.isError }
  }
  const artifactFile = (id: string): string => {
    const a = db.artifacts().find((x) => x.id === id)!
    return readFileSync(join(dataDir, 'artifacts', a.id, a.name), 'utf8')
  }

  it('runs commands as root in a Linux box', async () => {
    const r = await run('bash', { command: 'uname -s && whoami && pwd && node --version && python3 --version' })
    expect(r.isError).toBe(false)
    expect(r.text).toMatch(/Linux\nroot\n\/work\nv22\./)
    expect((await run('bash', { command: 'exit 3' })).isError).toBe(true)
    expect((await run('bash', { command: 'sleep 5', timeout_seconds: 1 })).text).toContain('passou de 1 s')
  }, 60_000)

  it('writes, reads and edits files, which land in /work on the Mac', async () => {
    expect((await run('write_file', { path: 'notas/a.txt', content: 'um\ndois\n' })).isError).toBe(false)
    expect((await run('edit_file', { path: 'notas/a.txt', old_text: 'dois', new_text: 'três' })).isError).toBe(false)
    expect((await run('read_file', { path: '/work/notas/a.txt' })).text).toBe('um\ntrês\n')
    expect(readFileSync(join(computers.folder(lia.id), 'notas/a.txt'), 'utf8')).toBe('um\ntrês\n')
    expect((await run('edit_file', { path: 'notas/a.txt', old_text: 'nada', new_text: 'x' })).isError).toBe(true)
  }, 30_000)

  it('cannot reach the Mac through a symlink in /work', async () => {
    await run('bash', { command: `ln -sf ${process.env['HOME']}/.zshrc /work/escape && ln -sf /etc/hostname /work/host` })
    expect((await run('read_file', { path: 'escape' })).isError).toBe(true) // resolves inside the computer, where it does not exist
    expect((await computers.call(lia, 'show_file', { path: 'escape' }, ctx)).artifact).toBeUndefined()
    const shown = await computers.call(lia, 'show_file', { path: 'host' }, ctx)
    expect(artifactFile(shown.artifact!.id).trim()).toBe('lia') // the computer's hostname, not the Mac's
  }, 30_000)

  it('keeps no CLI credentials and publishes ports only on 127.0.0.1', async () => {
    const r = await run('bash', { command: 'ls -a /root; env' })
    expect(r.text).not.toMatch(/\.claude|\.codex|ANTHROPIC|OPENAI/)
    const ports = execFileSync('docker', ['port', computers.name(lia.id)], { encoding: 'utf8' })
    expect(ports.trim().split('\n').every((l) => l.includes('-> 127.0.0.1:'))).toBe(true)
  }, 30_000)

  it('runs a web service reachable from the Mac, and explains one bound to localhost', async () => {
    await run('write_file', { path: 'site/index.html', content: '<h1>Vendas</h1>' })
    const ok = await computers.call(lia, 'start_service', { name: 'site', command: 'cd site && python3 -m http.server 8000 --bind 0.0.0.0', port: 8000 }, ctx)
    expect(ok.result.isError).toBeFalsy()
    expect(ok.service).toBe('site')
    const svc = computers.info(lia).services.find((s) => s.name === 'site')!
    expect(svc.running).toBe(true)
    expect(await (await fetch(svc.url!)).text()).toContain('Vendas')

    const local = await run('start_service', { name: 'local', command: 'python3 -m http.server 8080 --bind 127.0.0.1', port: 8080 })
    expect(local.isError).toBe(true)
    expect(local.text).toContain('só em localhost')
    expect((await run('start_service', { name: 'x', command: 'true', port: 9999 })).isError).toBe(true)

    await run('stop_service', { name: 'local' })
    await run('stop_service', { name: 'site' })
    expect(computers.info(lia).services).toEqual([])
  }, 120_000)

  it('takes screenshots of its own services through the published port', async () => {
    await computers.call(lia, 'start_service', { name: 'site', command: 'cd site && python3 -m http.server 8000 --bind 0.0.0.0', port: 8000 }, ctx)
    const out = await computers.call(lia, 'screenshot', { url: 'http://localhost:8000/' }, ctx)
    expect(out.result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(shots.at(-1)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(out.artifact?.kind).toBe('image')
    expect((await run('bash', { command: 'ls /work/.prints' })).text).toMatch(/print-.*\.png/)
    await run('stop_service', { name: 'site' })
  }, 90_000)

  it('only agents with a computer get the tools', async () => {
    const gateway = new Gateway()
    await gateway.start()
    const engines: Record<EngineId, Engine> = { claude: fakeEngine('claude', { delayMs: 1 }), codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi') }
    const runner = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-w-')), gateway, computers })
    await runner.send('d1', 'rode `echo oi do computador`')
    await runner.send('d2', 'rode `echo oi do computador`')
    await runner.idle()
    await gateway.stop()
    const reply = (conv: string) => db.messages().find((m) => m.conversationId === conv && m.author.kind === 'agent')!
    expect(reply('d1').text).toContain('oi do computador')
    expect(reply('d1').run?.steps.map((s) => s.label)).toContain('Rodou')
    expect(reply('d2').text).not.toContain('oi do computador')
    expect(reply('d2').run?.steps.map((s) => s.label)).not.toContain('Rodou')
  }, 60_000)

  it("works on a lent Mac folder, keeps what it installed, and doesn't touch the Mac's node_modules", async () => {
    const project = mkdtempSync(join(tmpdir(), 'ad-project-'))
    writeFileSync(join(project, 'README.md'), 'projeto do Mac')
    mkdirSync(join(project, 'node_modules'))
    writeFileSync(join(project, 'node_modules', 'mac.txt'), 'binário do Mac')
    await run('bash', { command: 'echo instalado > /opt/marca' })

    db.setFolders(lia.id, [{ name: 'app', path: project, readOnly: false }])
    await computers.ensure(lia.id)
    lia = db.agent(lia.id)!
    expect((await run('bash', { command: 'cat /opt/marca /projetos/app/README.md' })).text).toContain('instalado\nprojeto do Mac')
    await run('bash', { command: 'cd /projetos/app && echo novo > feito.txt && ls node_modules && echo linux > node_modules/linux.txt && git init -q && git status --short' })
    expect(readFileSync(join(project, 'feito.txt'), 'utf8')).toBe('novo\n')
    expect(existsSync(join(project, 'node_modules', 'linux.txt'))).toBe(false)
    expect(readFileSync(join(project, 'node_modules', 'mac.txt'), 'utf8')).toBe('binário do Mac')

    db.setFolders(lia.id, [{ name: 'app', path: project, readOnly: true }])
    await computers.ensure(lia.id)
    expect((await run('write_file', { path: '/projetos/app/x.txt', content: 'x' })).text).toContain('Read-only file system')
    expect(existsSync(join(project, 'x.txt'))).toBe(false)

    db.setFolders(lia.id, [])
    await computers.ensure(lia.id)
    expect((await run('bash', { command: 'ls /projetos/app' })).isError).toBe(true)
    expect((await run('bash', { command: 'cat /opt/marca' })).text).toContain('instalado')
  }, 240_000)
})
