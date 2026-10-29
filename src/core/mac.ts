// An agent whose computer is this one (spec §23; "this Mac" on a Mac): the same tools
// as the Linux computer, run directly here as the user, with what is installed here.
// Chosen per agent, by the user, knowing it reaches everything the user reaches.
// What stays: every call is a step in the chat, the run guards still apply, and
// commands get the user's own shell environment, never the app's.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, closeSync, unlinkSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { L } from '../shared/lang'
import type { CoreEvent } from '../shared/rpc'
import type { Agent, Artifact, ComputerInfo, Service } from '../shared/types'
import type { Db } from './db'
import { fallbackPath, loginShell, osOf, systemName } from './platform'
import { textResult, type ToolDef } from './gateway'
import { artifactKind, badName, edited, manyMatches, clipOutput, diedAtStart, emptyOld, fileText, formatExec, isBinary, linuxTools, noService, noShots, notInFile, notOpenYet, portTaken, seenImage, shown, tooBig, type Shooter, type ToolOutcome } from './computer'

const MAX_FILE = 200_000
const MAX_SHOW_BYTES = 50 * 1024 * 1024
const RESERVED_PORTS = [47_717, 47_718] // the app's own webhook and git proxy

// What the agent is told about this computer: the system, and what is usually installed.
const installed = (): string => (osOf() === 'mac' ? 'Homebrew, Python, Node…' : 'apt, Python, Node…')

const macDescriptions = (): Record<string, string> => ({
  bash: L(
    `Roda um comando no computador do usuário (${systemName()}, como o próprio usuário, com o que ele tem instalado: ${installed()}), por padrão na sua pasta de trabalho. Pra servidores que ficam rodando, use start_service.`,
    `Runs a command on the user's computer (${systemName()}, as the user, with what they have installed: ${installed()}), by default in your working folder. For servers that keep running, use start_service.`
  ),
  read_file: L('Lê um arquivo de texto deste computador.', 'Reads a text file from this computer.'),
  write_file: L('Cria ou sobrescreve um arquivo neste computador, criando as pastas que faltarem.', 'Creates or overwrites a file on this computer, creating any missing folders.'),
  start_service: L(
    'Deixa um processo rodando em segundo plano neste computador (servidor web, API, dashboard) e confere se ele abriu a porta (qualquer porta acima de 1024 que esteja livre). O log fica na pasta de trabalho, em .logs/<nome>.log. Iniciar de novo com o mesmo nome reinicia.',
    'Leaves a process running in the background on this computer (web server, API, dashboard) and checks that it opened the port (any free port above 1024). The log goes to the working folder, in .logs/<name>.log. Starting again with the same name restarts it.'
  ),
  screenshot: L(
    'Tira um print de uma página web e mostra no chat; você também recebe a imagem. Serve http://localhost:<porta> (este computador) ou qualquer URL da internet.',
    'Takes a screenshot of a web page and shows it in the chat; you get the image too. Works with http://localhost:<port> (this computer) or any URL on the internet.'
  ),
  show_file: L(
    'Mostra um arquivo deste computador no chat: imagem, vídeo, Markdown, HTML, PDF, CSV ou texto (até 50 MB). O arquivo é guardado como está agora. Se for imagem, você também a recebe pra conferir.',
    'Shows a file from this computer in the chat: image, video, Markdown, HTML, PDF, CSV or text (up to 50 MB). The file is kept as it is now. If it is an image, you get it too, to check.'
  )
})

// The same tools, described for this computer (a function: computer.ts and this file import each other).
export const macTools = (): ToolDef[] => {
  const descriptions = macDescriptions()
  return linuxTools().map((t) => {
    const description = descriptions[t.name] ?? t.description
    const props = (t.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {}
    const properties = Object.fromEntries(
      Object.entries(props).map(([k, v]) => [
        k,
        k === 'path'
          ? { ...v, description: L('Caminho absoluto, com ~, ou relativo à pasta de trabalho.', 'Absolute path, with ~, or relative to the working folder.') }
          : k === 'command' && t.name === 'start_service'
            ? { ...v, description: L('Comando, rodado na pasta de trabalho.', 'Command, run in the working folder.') }
            : v
      ])
    )
    return { ...t, description, inputSchema: { ...t.inputSchema, properties } as ToolDef['inputSchema'] }
  })
}

// A path as the agent writes it, on this computer.
export function macPath(p: string, cwd: string): string {
  const s = p.trim()
  if (s === '~' || s.startsWith('~/')) return normalize(join(homedir(), s.slice(1)))
  return normalize(isAbsolute(s) ? s : join(cwd, s))
}

type Exec = { code: number; stdout: string; stderr: string }

// The user's own environment, as a new terminal would have it (PATH from the
// shell's profile: Homebrew, asdf, pyenv…), built from a clean start so that
// nothing of the app's process goes along.
let envOnce: Promise<NodeJS.ProcessEnv> | undefined
export function loginEnv(): Promise<NodeJS.ProcessEnv> {
  envOnce ??= new Promise((resolve) => {
    const base: NodeJS.ProcessEnv = {
      HOME: homedir(),
      USER: process.env['USER'],
      LOGNAME: process.env['LOGNAME'] ?? process.env['USER'],
      SHELL: loginShell(),
      LANG: process.env['LANG'] ?? 'pt_BR.UTF-8',
      TMPDIR: process.env['TMPDIR'],
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
    }
    const marker = '__TUCANO_ENV__'
    const child = spawn(base.SHELL!, ['-ilc', `printf '${marker}\\0'; env -0`], { env: base, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    const done = (): void => {
      const at = out.indexOf(`${marker}\0`)
      if (at < 0) return resolve({ ...base, PATH: fallbackPath() })
      const env: NodeJS.ProcessEnv = {}
      for (const pair of out.slice(at + marker.length + 1).split('\0')) {
        const i = pair.indexOf('=')
        if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1)
      }
      resolve(env)
    }
    const timer = setTimeout(() => (child.kill('SIGKILL'), done()), 15_000)
    child.on('close', () => (clearTimeout(timer), done()))
    child.on('error', () => (clearTimeout(timer), done()))
  })
  return envOnce
}

function run(command: string, opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutSeconds: number; signal?: AbortSignal }): Promise<Exec> {
  return new Promise((resolve) => {
    // Its own process group, so a timeout or a stop takes the children with it.
    const child = spawn('/bin/bash', ['-c', command], { cwd: opts.cwd, env: { ...opts.env, TERM: 'dumb' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout = (stdout + d).slice(-2_000_000)))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(-200_000)))
    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig)
      } catch {
        /* already gone */
      }
    }
    const stop = (): void => {
      killGroup('SIGTERM')
      setTimeout(() => killGroup('SIGKILL'), 5000).unref()
    }
    const timer = setTimeout(() => ((timedOut = true), stop()), opts.timeoutSeconds * 1000)
    opts.signal?.addEventListener('abort', stop, { once: true })
    child.on('error', (e) => (stderr += e.message))
    child.on('close', (code) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', stop)
      resolve({ code: timedOut ? 124 : (code ?? -1), stdout, stderr })
    })
  })
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port })
    const end = (ok: boolean): void => (s.destroy(), resolve(ok))
    s.setTimeout(800, () => end(false))
    s.once('connect', () => end(true))
    s.once('error', () => end(false))
  })
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export interface MacDeps {
  db: Db
  dataDir: string
  emit: (e: CoreEvent) => void
  shoot?: Shooter
  env?: () => Promise<NodeJS.ProcessEnv> // tests pass their own
}

export class MacComputer {
  constructor(private deps: MacDeps) {}

  // Its own working folder.
  folder(agentId: string): string {
    return join(this.deps.dataDir, 'computers', agentId, 'work')
  }

  // Where commands start: the agent's own folder.
  cwd(agent: Agent): string {
    const own = this.folder(agent.id)
    mkdirSync(own, { recursive: true })
    return own
  }

  private pidFile(agentId: string, name: string): string {
    return join(this.folder(agentId), '.run', `${name}.pid`)
  }

  private pid(agentId: string, name: string): number | undefined {
    try {
      const n = Number(readFileSync(this.pidFile(agentId, name), 'utf8').trim())
      return n > 0 ? n : undefined
    } catch {
      return undefined
    }
  }

  services(agentId: string): Service[] {
    return this.deps.db.services(agentId).map((s) => {
      const pid = this.pid(agentId, s.name)
      const running = !!pid && alive(pid)
      return { ...s, running, url: running ? `http://127.0.0.1:${s.port}` : undefined }
    })
  }

  info(agent: Agent): ComputerInfo {
    return { agentId: agent.id, state: agent.computer ? 'running' : 'off', kind: 'mac', folder: this.folder(agent.id), services: agent.computer ? this.services(agent.id) : [] }
  }

  refresh(agent: Agent): void {
    this.deps.emit({ type: 'computer', computer: this.info(agent) })
  }

  async stopService(agentId: string, name: string): Promise<boolean> {
    const pid = this.pid(agentId, name)
    let stopped = true
    if (pid && alive(pid)) {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        stopped = false
      }
      for (let i = 0; i < 6 && alive(pid); i++) await new Promise((r) => setTimeout(r, 500))
      if (alive(pid))
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          /* gone */
        }
    }
    rmSync(this.pidFile(agentId, name), { force: true })
    this.deps.db.removeServices(agentId, name)
    const agent = this.deps.db.agent(agentId)
    if (agent) this.refresh(agent)
    return stopped
  }

  async stopAll(agentId: string): Promise<void> {
    for (const s of this.deps.db.services(agentId)) await this.stopService(agentId, s.name)
  }

  // Only the agent's own folder: its services, prints and logs. Never anything else of the computer.
  async erase(agentId: string): Promise<void> {
    await this.stopAll(agentId)
    rmSync(join(this.deps.dataDir, 'computers', agentId), { recursive: true, force: true })
  }

  private env(): Promise<NodeJS.ProcessEnv> {
    return (this.deps.env ?? loginEnv)()
  }

  private async startService(agent: Agent, args: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<ToolOutcome> {
    const name = typeof args['name'] === 'string' ? args['name'].trim() : ''
    const command = typeof args['command'] === 'string' ? args['command'].trim() : ''
    const port = Number(args['port'])
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name)) return { result: textResult(badName(), true) }
    if (!command) return { result: textResult(L('Faltou o comando.', 'Missing the command.'), true) }
    if (!Number.isInteger(port) || port < 1024 || port > 65_535 || RESERVED_PORTS.includes(port)) return { result: textResult(L(`Porta ${port} não serve: use uma acima de 1024 (e fora de ${RESERVED_PORTS.join(', ')}).`, `Port ${port} won't do: use one above 1024 (and not ${RESERVED_PORTS.join(', ')}).`), true) }
    const taken = this.deps.db.services(agent.id).find((s) => s.port === port && s.name !== name)
    if (taken) return { result: textResult(portTaken(port, taken.name), true) }
    if (this.deps.db.services(agent.id).some((s) => s.name === name)) await this.stopService(agent.id, name)
    if (await portOpen(port)) return { result: textResult(L(`A porta ${port} já está em uso neste computador por outro programa. Use outra.`, `Port ${port} is already in use on this computer by another program. Use another.`), true) }

    const logs = join(this.folder(agent.id), '.logs')
    mkdirSync(logs, { recursive: true })
    mkdirSync(dirname(this.pidFile(agent.id, name)), { recursive: true })
    const log = join(logs, `${name}.log`)
    const fd = openSync(log, 'w')
    const child = spawn('/bin/bash', ['-c', command], { cwd, env: { ...(await this.env()), TERM: 'dumb' }, detached: true, stdio: ['ignore', fd, fd] })
    closeSync(fd)
    child.unref()
    if (!child.pid) return { result: textResult(L('Não consegui iniciar o processo.', "I couldn't start the process."), true) }
    writeFileSync(this.pidFile(agent.id, name), String(child.pid))
    this.deps.db.saveService(agent.id, { name, command, port, startedAt: Date.now() })

    let open = false
    for (let i = 0; i < 60 && !signal?.aborted && alive(child.pid); i++) {
      if ((open = await portOpen(port))) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    this.refresh(agent)
    let tail = ''
    try {
      tail = readFileSync(log, 'utf8').split('\n').slice(-30).join('\n').trim()
    } catch {
      /* no log */
    }
    const withLog = (msg: string): string => `${msg}${tail ? `\n\n${L(`Últimas linhas do log (${log})`, `Last lines of the log (${log})`)}:\n${clipOutput(tail, 4000)}` : ''}`
    if (!alive(child.pid)) {
      unlinkSync(this.pidFile(agent.id, name))
      this.deps.db.removeServices(agent.id, name)
      return { result: textResult(withLog(diedAtStart()), true) }
    }
    if (!open) return { result: textResult(withLog(notOpenYet(port))), service: name }
    return { result: textResult(withLog(L(`"${name}" está no ar em http://localhost:${port}. O usuário vê um botão pra abrir no chat.`, `"${name}" is up at http://localhost:${port}. The user sees a button to open it in the chat.`))), service: name }
  }

  private read(path: string): CallToolResult {
    try {
      if (statSync(path).isDirectory()) return textResult(L(`${path} é uma pasta.`, `${path} is a folder.`), true)
      const buf = readFileSync(path)
      if (buf.subarray(0, 8000).includes(0)) return textResult(isBinary(path), true)
      const text = buf.toString('utf8')
      return textResult(fileText(text, MAX_FILE))
    } catch (e) {
      return textResult(L(`Não consegui ler ${path}: ${e instanceof Error ? e.message : String(e)}`, `I couldn't read ${path}: ${e instanceof Error ? e.message : String(e)}`), true)
    }
  }

  private write(path: string, content: string): CallToolResult {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      return textResult(L(`Escrevi ${path} (${Buffer.byteLength(content)} bytes).`, `Wrote ${path} (${Buffer.byteLength(content)} bytes).`))
    } catch (e) {
      return textResult(L(`Não consegui escrever ${path}: ${e instanceof Error ? e.message : String(e)}`, `I couldn't write ${path}: ${e instanceof Error ? e.message : String(e)}`), true)
    }
  }

  private keep(agentId: string, ctx: { conversationId: string; messageId: string }, file: { name: string; title: string; source: string; data?: Buffer; path?: string }): Artifact | { error: string } {
    const name = file.name.replace(/[\\/]/g, '_') || 'arquivo'
    if (file.path) {
      try {
        const st = statSync(file.path)
        if (!st.isFile()) return { error: L(`${file.path} não é um arquivo.`, `${file.path} isn't a file.`) }
        if (st.size > MAX_SHOW_BYTES) return { error: tooBig() }
      } catch {
        return { error: L(`Não achei ${file.path}.`, `I couldn't find ${file.path}.`) }
      }
    }
    const id = randomUUID()
    const dir = join(this.deps.dataDir, 'artifacts', id)
    mkdirSync(dir, { recursive: true })
    if (file.path) copyFileSync(file.path, join(dir, name))
    else writeFileSync(join(dir, name), file.data ?? Buffer.alloc(0))
    const artifact: Artifact = { id, agentId, conversationId: ctx.conversationId, messageId: ctx.messageId, kind: artifactKind(name), name, title: file.title, source: file.source, size: statSync(join(dir, name)).size, createdAt: Date.now() }
    this.deps.db.saveArtifact(artifact)
    this.deps.emit({ type: 'artifact', artifact })
    return artifact
  }

  private async screenshot(agent: Agent, args: Record<string, unknown>, ctx: { conversationId: string; messageId: string }): Promise<ToolOutcome> {
    if (!this.deps.shoot) return { result: textResult(noShots(), true) }
    const url = String(args['url'] ?? '')
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return { result: textResult(L(`URL inválida: ${url}`, `Invalid URL: ${url}`), true) }
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { result: textResult(L('Só URLs http e https.', 'Only http and https URLs.'), true) }
    let png: Buffer
    try {
      png = await this.deps.shoot({ url: u.toString(), width: Math.min(2560, Math.max(320, Number(args['width']) || 1280)), height: 800, fullPage: args['full_page'] === true })
    } catch (e) {
      return { result: textResult(L(`Não consegui abrir ${url}: ${e instanceof Error ? e.message : String(e)}`, `I couldn't open ${url}: ${e instanceof Error ? e.message : String(e)}`), true) }
    }
    const file = `print-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
    const saved = join(this.folder(agent.id), '.prints', file)
    mkdirSync(dirname(saved), { recursive: true })
    writeFileSync(saved, png)
    const kept = this.keep(agent.id, ctx, { name: file, title: L(`Print de ${url}`, `Screenshot of ${url}`), source: url, data: png })
    if ('error' in kept) return { result: textResult(kept.error, true) }
    return { result: { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: L(`Print de ${url}, mostrado no chat e salvo em ${saved}.`, `Screenshot of ${url}, shown in the chat and saved at ${saved}.`) }] }, artifact: kept }
  }

  async call(agent: Agent, name: string, args: Record<string, unknown>, ctx: { conversationId: string; messageId: string; signal?: AbortSignal }): Promise<ToolOutcome> {
    const cwd = this.cwd(agent)
    const path = (): string => macPath(String(args['path'] ?? ''), cwd)
    switch (name) {
      case 'bash': {
        const command = String(args['command'] ?? '').trim()
        if (!command) return { result: textResult(L('Faltou o comando.', 'Missing the command.'), true) }
        const t = Math.min(600, Math.max(1, Number(args['timeout_seconds']) || 120))
        const r = await run(command, { cwd, env: await this.env(), timeoutSeconds: t, signal: ctx.signal })
        return { result: textResult(formatExec(r, t), r.code !== 0) }
      }
      case 'read_file':
        return { result: this.read(path()) }
      case 'write_file':
        return { result: this.write(path(), String(args['content'] ?? '')) }
      case 'edit_file': {
        const file = path()
        const oldText = String(args['old_text'] ?? '')
        const newText = String(args['new_text'] ?? '')
        if (!oldText) return { result: textResult(emptyOld(), true) }
        const current = this.read(file)
        if (current.isError) return { result: current }
        const text = (current.content[0] as { text: string }).text
        const count = text.split(oldText).length - 1
        if (count === 0) return { result: textResult(notInFile(), true) }
        if (count > 1 && args['replace_all'] !== true) return { result: textResult(manyMatches(count), true) }
        const next = args['replace_all'] === true ? text.split(oldText).join(newText) : text.replace(oldText, () => newText)
        const r = this.write(file, next)
        return { result: r.isError ? r : textResult(edited(file, count)) }
      }
      case 'start_service':
        return this.startService(agent, args, cwd, ctx.signal)
      case 'stop_service': {
        const svc = String(args['name'] ?? '')
        if (!this.deps.db.services(agent.id).some((s) => s.name === svc)) return { result: textResult(noService(svc), true) }
        await this.stopService(agent.id, svc)
        return { result: textResult(L(`Parei "${svc}".`, `Stopped "${svc}".`)) }
      }
      case 'screenshot':
        return this.screenshot(agent, args, ctx)
      case 'show_file': {
        const file = path()
        const title = (typeof args['title'] === 'string' && args['title'].trim()) || basename(file)
        const kept = this.keep(agent.id, ctx, { name: basename(file), title, source: file, path: file })
        if ('error' in kept) return { result: textResult(kept.error, true) }
        const image = seenImage(file)
        const said = { type: 'text' as const, text: shown(title, !!image) }
        return { result: { content: image ? [image, said] : [said] }, artifact: kept }
      }
      default:
        return { result: textResult(L(`Ferramenta desconhecida: ${name}`, `Unknown tool: ${name}`), true) }
    }
  }
}
