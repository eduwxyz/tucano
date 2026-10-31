import { execFile, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { GATEWAY_NAME } from './claude'
import { opencodeProviderEnvNames } from './provider-env'
import { num, parseJson, runCli } from './cli'
import { opencodeParser, userOpencodeProviders } from './opencode'
import type { EngineEvent, Turn, Usage } from './types'
import { L } from '../../shared/lang'
import { isWin, killTree, spawnable, trackWslStderr } from '../platform'
import { activeWslDistro, forgetWslProcess, windowsPathToWsl } from '../wsl'

// OpenCode 2 kept the `opencode` command and OPENCODE_CONFIG_CONTENT, but changed
// the config to native V2 shapes (agents with system instead of the singular agent
// with prompt, mcp.servers, update, snapshots) and moved to a client-server model.
// The same OpenCode engine runs both: the installed version picks the way.
export const opencodeMajor = (version: string | undefined): number => (version && parseInt(version, 10)) || 1

export function opencodeV2Config(turn: Pick<Turn, 'system' | 'mcpUrl' | 'web'>, providers: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    ...providers,
    share: 'disabled',
    update: 'disable',
    snapshots: false,
    mcp: turn.mcpUrl ? { servers: { [GATEWAY_NAME]: { type: 'remote', url: turn.mcpUrl, disabled: false } } } : {},
    tools: { '*': false, [`${GATEWAY_NAME}_*`]: true, webfetch: !!turn.web, websearch: !!turn.web },
    agents: { tucano: { system: turn.system } }
  }
}

// The turn runs on a private server of its own (see runOpencodeV2), so it never starts or
// fights over the person's background service. The app picks the session id, so the
// session can be read and deleted even when the turn is stopped early.
export function opencodeV2Args(turn: Pick<Turn, 'model' | 'images'>, session: string, server: string): string[] {
  return ['run', '--server', server, '--format', 'json', '--agent', 'tucano', '-m', turn.model, '--session', session, ...(turn.images ?? []).filter((i) => existsSync(i.path)).flatMap((i) => ['-f', i.path])]
}

// V2 keeps its logins in its database, in the data dir, so the data dir stays the
// person's (V1 linked auth.json instead). What would change the agent's behavior stays
// out: the config dir (AGENTS.md, plugins, agents, MCP servers) and the state are the
// app's own, and Claude Code's files and the project's config aren't read.
export function opencodeV2Env(appDir: string): Record<string, string> {
  const config = join(appDir, 'v2', 'config')
  const state = join(appDir, 'v2', 'state')
  for (const d of [config, state]) mkdirSync(join(d, 'opencode'), { recursive: true })
  return {
    XDG_CONFIG_HOME: config,
    OPENCODE_CONFIG_DIR: join(config, 'opencode'),
    XDG_STATE_HOME: state,
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1'
  }
}

// What a session used, from `opencode session export`: V2's stream leaves out the
// step_finish of the last step, so the stream alone undercounts the turn.
export function sessionUsage(exported: string): Usage | undefined {
  const info = parseJson(exported)?.['info'] as Record<string, unknown> | undefined
  const t = info?.['tokens'] as Record<string, unknown> | undefined
  if (!t) return undefined
  const cache = (t['cache'] ?? {}) as Record<string, unknown>
  const cost = num(info!['cost'])
  return {
    inputTokens: num(t['input']) + num(cache['read']) + num(cache['write']),
    cacheReadTokens: num(cache['read']),
    outputTokens: num(t['output']) + num(t['reasoning']),
    ...(cost ? { apiCostUsd: cost } : {})
  }
}

const cli = (bin: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, forwardEnv: string[]): Promise<string> => {
  const s = spawnable(bin, args, { env, cwd, forwardEnv })
  return new Promise((resolve) => execFile(s.file, s.args, { env: s.hostEnv ?? env, cwd: s.wsl ? undefined : cwd, timeout: 20_000, windowsHide: true, windowsVerbatimArguments: s.verbatim }, (_err, stdout) => (s.cleanup?.(), resolve(String(stdout)))))
}

// `opencode serve` on a free local port, with a password of the turn's own.
async function startServer(bin: string, env: NodeJS.ProcessEnv, cwd: string, forwardEnv: string[]): Promise<{ url?: string; stop: () => Promise<void> }> {
  const s = spawnable(bin, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { env, cwd, forwardEnv })
  const child = spawn(s.file, s.args, { env: s.hostEnv ?? env, cwd: s.wsl ? undefined : cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: s.verbatim })
  const exited = new Promise<void>((resolve) => child.on('close', () => (s.cleanup?.(), child.pid && forgetWslProcess(child.pid), resolve())))
  // With the app's MCP connection open it can linger on SIGTERM; the turn waits for it to end.
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    // On Windows the server may sit behind cmd.exe or a node wrapper: only killing the tree reaches it.
    if (isWin && child.pid) killTree(child.pid)
    else child.kill('SIGTERM')
    const kill = setTimeout(() => (isWin && child.pid ? killTree(child.pid, 'SIGKILL') : child.kill('SIGKILL')), 2_000)
    await exited
    clearTimeout(kill)
  }
  const url = await new Promise<string | undefined>((resolve) => {
    let out = ''
    const done = (u: string | undefined): void => {
      clearTimeout(timer)
      child.stdout.removeAllListeners('data')
      child.stderr.removeAllListeners('data')
      child.stdout.resume()
      child.stderr.resume()
      resolve(u)
    }
    const read = (chunk: Buffer): void => {
      const text = trackWslStderr(child.pid, s, chunk.toString())
      out = (out + text).slice(-4000)
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out)
      if (m) done(m[1])
    }
    const timer = setTimeout(() => done(undefined), 20_000)
    let stderrSeen = ''
    child.stdout.on('data', read)
    child.stderr.on('data', (chunk: Buffer) => {
      const combined = stderrSeen + chunk.toString()
      trackWslStderr(child.pid, s, combined)
      stderrSeen = combined.slice(-8000)
      read(chunk)
    })
    child.on('close', () => done(undefined))
  })
  return { url, stop }
}

// Until the app's MCP server is connected (or failed): V2 doesn't wait for it before the
// first step, so a turn started right away often doesn't see the app's tools. "Connected"
// comes a moment before the tools reach the turn's list; against v2.2.0, 300 ms after it
// was enough in every try, so the turn waits a little more than that.
const MCP_SETTLE_MS = 500
async function mcpReady(server: string, password: string, cwd: string, signal: AbortSignal): Promise<void> {
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  for (let i = 0; i < 70 && !signal.aborted; i++) {
    try {
      const res = await fetch(`${server}/api/mcp?directory=${encodeURIComponent(cwd)}`, { headers: { authorization: auth }, signal })
      const body = (await res.json()) as { data?: { name?: string; status?: { status?: string } }[] }
      const status = body.data?.find((s) => s.name === GATEWAY_NAME)?.status?.status
      if (status === 'connected') return void (await new Promise((r) => setTimeout(r, MCP_SETTLE_MS)))
      if (status === 'failed') return
    } catch {
      // not answering yet
    }
    await new Promise((r) => setTimeout(r, 150))
  }
}

export async function* runOpencodeV2(path: string, turn: Turn, appDir: string, shellEnv: NodeJS.ProcessEnv, providers = userOpencodeProviders(undefined, true), userData?: string): AsyncIterable<EngineEvent> {
  const password = randomBytes(24).toString('hex')
  const distro = activeWslDistro()
  const cwd = distro ? windowsPathToWsl(turn.cwd, distro) : turn.cwd
  const isolated = opencodeV2Env(appDir)
  if (userData && existsSync(join(userData, 'auth.json'))) {
    try {
      copyFileSync(join(userData, 'auth.json'), join(isolated.XDG_STATE_HOME!, 'opencode', 'auth.json'))
    } catch {
      // The provider settings can still work without copying an optional login file.
    }
  }
  const env = { ...process.env, ...shellEnv, ...isolated, PWD: cwd, OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeV2Config(turn, providers)) }
  const forwardEnv = [...Object.keys(isolated), 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_CONFIG_CONTENT', ...opencodeProviderEnvNames(providers)]
  const session = `ses_tucano${randomUUID().replaceAll('-', '')}`
  const server = await startServer(path, env, turn.cwd, forwardEnv)
  try {
    if (!server.url) {
      yield { type: 'error', message: L('O OpenCode não abriu o servidor dele para a resposta.', "OpenCode didn't start its server for the reply.") }
      return
    }
    if (turn.mcpUrl) await mcpReady(server.url, password, cwd, turn.signal)
    if (turn.signal.aborted) return
    let done: Extract<EngineEvent, { type: 'done' }> | undefined
    for await (const ev of runCli({ bin: path, args: opencodeV2Args(turn, session, server.url), stdin: turn.prompt, cwd: turn.cwd, signal: turn.signal, parser: opencodeParser(), env, forwardEnv })) {
      if (ev.type === 'done') done = ev
      // Stopped, V2 reports the dropped connection to its server: not the turn's error.
      else if (!(ev.type === 'error' && turn.signal.aborted)) yield ev
    }
    const usage = sessionUsage(await cli(path, ['session', 'export', session, '--server', server.url], env, turn.cwd, forwardEnv))
    if (done) yield usage ? { ...done, usage } : done
    // Stopped mid-turn: what it used so far still counts against the limit.
    else if (usage) yield { type: 'progress', tokens: usage.inputTokens + usage.outputTokens, cacheRead: usage.cacheReadTokens }
  } finally {
    // The turn is the app's, not the person's: it leaves nothing in their OpenCode history.
    if (server.url) await cli(path, ['session', 'delete', session, '--server', server.url], env, turn.cwd, forwardEnv)
    await server.stop()
  }
}
