import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse } from 'smol-toml'
import { GATEWAY_NAME } from './claude'
import { lastLines, num, parseJson, runCli, type Parser } from './cli'
import { CodexApp, Unsupported, type Launch } from './codex-app'
import type { Engine, EngineEvent, Turn, TurnShape } from './types'
import { L } from '../../shared/lang'

// Codex reads AGENTS.md, skills, plugins and memories from the user's home no
// matter which flags are passed, so Tucano runs it with a home of its
// own. The user logs into Codex once more, for the app, through Codex itself.
export function asdfEnv(bin?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  // An asdf shim needs its install directory and selected tool version: HOME
  // and the working directory both belong to Tucano when it checks the login.
  if (bin) {
    try {
      const shim = readFileSync(bin, 'utf8')
      const match = /^# asdf-plugin:\s+([\w-]+)\s+([^\s]+)/m.exec(shim)
      if (match) {
        env['ASDF_DATA_DIR'] = dirname(dirname(bin))
        const versionKey = `ASDF_${match[1]!.replaceAll('-', '_').toUpperCase()}_VERSION`
        if (!process.env[versionKey]) env[versionKey] = match[2]
        return env
      }
    } catch {
      // Native harness installs do not need an asdf data directory.
    }
  }
  if (process.env['ASDF_DATA_DIR']) env['ASDF_DATA_DIR'] = process.env['ASDF_DATA_DIR']
  return env
}

export function codexEnv(home: string, bin?: string): NodeJS.ProcessEnv {
  return { ...process.env, ...asdfEnv(bin), HOME: home, CODEX_HOME: join(home, '.codex') }
}

// How the user's own Codex reaches the model, from their config.toml: the
// provider it uses (a company gateway: base_url, and the variable that holds
// its key) and the OpenAI base URL. --ignore-user-config leaves the rest out
// (MCP servers, profiles, rules). Read at every turn.
export interface CodexProvider {
  config: string[] // -c flags
  envNames: string[] // variables of the user's shell the provider reads
  baseUrl?: string
}

export function userCodexProvider(dir = process.env['CODEX_HOME'] || join(homedir(), '.codex')): CodexProvider {
  let c: Record<string, unknown>
  try {
    c = parse(readFileSync(join(dir, 'config.toml'), 'utf8'))
  } catch {
    return { config: [], envNames: [] }
  }
  const config: string[] = []
  const envNames = ['OPENAI_BASE_URL']
  const id = typeof c['model_provider'] === 'string' ? c['model_provider'] : undefined
  const p = id ? (c['model_providers'] as Record<string, Record<string, unknown>> | undefined)?.[id] : undefined
  if (id) config.push('-c', `model_provider=${toml(id)}`)
  // -c splits its key on dots and takes no quotes, so only plain ids pass
  if (id && p && typeof p === 'object' && /^[\w-]+$/.test(id)) {
    config.push('-c', `model_providers.${id}=${toml(p)}`)
    if (typeof p['env_key'] === 'string') envNames.push(p['env_key'])
    const headers = p['env_http_headers']
    if (headers && typeof headers === 'object') envNames.push(...Object.values(headers).filter((v): v is string => typeof v === 'string'))
  }
  if (typeof c['openai_base_url'] === 'string') config.push('-c', `openai_base_url=${toml(c['openai_base_url'])}`)
  const baseUrl = typeof p?.['base_url'] === 'string' ? p['base_url'] : typeof c['openai_base_url'] === 'string' ? c['openai_base_url'] : undefined
  return { config, envNames, ...(baseUrl ? { baseUrl } : {}) }
}

// A value as inline TOML, the form -c takes.
function toml(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(toml).join(', ')}]`
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)} = ${toml(x)}`).join(', ')} }`
  return JSON.stringify(v)
}

// Built-in capabilities agents must not have: their tools come only from the gateway.
// Not code_mode_host: Codex routes every tool call through it, MCP ones included,
// and without it they all fail ("code-mode host is disabled"). It gives no shell
// or files of its own: asked to read ~/.zshrc with it, the model found no way to.
export const CODEX_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'apps',
  'plugins',
  'browser_use',
  'computer_use',
  'in_app_browser',
  'image_generation',
  'multi_agent',
  'goals',
  'view_image',
  'tool_suggest',
  'skill_search',
  'hooks',
  'memories'
]

// Flags that keep the CLI isolated: ignore config and rules, no skills, web
// search only when the agent has it, no project docs, built-in tools off, no saved session, and a
// read-only sandbox in an empty directory as a last line of defense. The prompt comes from stdin ("-"). The app's gateway,
// when given, is the only MCP server, with its tools approved up front: the
// gateway decides what runs.
// Codex tells the model its sandbox is read-only, which it is on purpose (an empty folder), and a model
// took that for the agent's computer: it answered "this session has read-only filesystem access"
// without trying write_file, or tried Codex's own apply_patch and gave up. Said plainly, it writes
// (GPT-6-Astra: 0 of 6 without it, 6 of 6 with it); hedged ("if you have a computer"), 1 of 3.
// So only an agent whose instructions give it write_file gets the part about files.
// The same block also says "Network access is restricted" and "Approval policy is never", and a model
// read that as "this session is read-only" for a push or a PR it had every grant for (0.2.18, an agent
// on "Este computador" with GitHub "Ler e escrever"). Codex's own sandbox has no say over the gateway's
// tools, so that block is left out (include_permissions_instructions=false), and the note says what
// does decide: each tool's result.
const sandboxNote = (computer: boolean): string =>
  [
    L(
      'O sandbox do próprio Codex aqui é vazio de propósito e não limita as suas ferramentas. Nunca diga que a sessão é só leitura: o que cada ferramenta pode fazer, e o que pede aprovação, vem do resultado dela; se algo for recusado ou pedir aprovação, diga exatamente o quê e por quê, com as palavras do resultado.',
      "Codex's own sandbox here is empty on purpose and doesn't limit your tools. Never say the session is read-only: what each tool can do, and what asks for approval, comes from its result; if something is refused or asks for approval, say exactly what and why, in the result's words."
    ),
    computer &&
      L(
        'Ele não é o seu computador, e o apply_patch e o shell dele não chegam lá. Os seus arquivos estão no seu computador: crie e mude com write_file e edit_file, que funcionam; comandos (git, instalar, rede) rodam com bash.',
        "It isn't your computer, and its apply_patch and shell don't reach it. Your files are on your computer: create and change them with write_file and edit_file, which do work; commands (git, installs, network) run with bash."
      )
  ]
    .filter(Boolean)
    .join(' ')

// The agent's instructions, with the sandbox note when it has the app's tools (and its part about files when it has a computer).
export const codexInstructions = (turn: Pick<Turn, 'system' | 'mcpUrl'>): string => (turn.mcpUrl ? `${turn.system}\n\n${sandboxNote(turn.system.includes('write_file'))}` : turn.system)

// What Codex says about its own sandbox and approvals: left out (see sandboxNote).
const NO_PERMISSIONS_TEXT = 'include_permissions_instructions=false'

export function codexArgs(turn: Pick<Turn, 'model' | 'effort' | 'system' | 'cwd' | 'mcpUrl' | 'web' | 'images'>, provider: string[] = []): string[] {
  const gateway = turn.mcpUrl
    ? [
        '-c', `mcp_servers.${GATEWAY_NAME}.url=${JSON.stringify(turn.mcpUrl)}`,
        '-c', `mcp_servers.${GATEWAY_NAME}.default_tools_approval_mode="approve"`,
        '-c', `mcp_servers.${GATEWAY_NAME}.tool_timeout_sec=900` // computer commands and installs take a while
      ]
    : []
  return [
    'exec',
    // Images go with the prompt; each flag takes one file, so none swallows the next argument.
    ...(turn.images ?? []).filter((i) => existsSync(i.path)).flatMap((i) => [`--image=${i.path}`]),
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '-s', 'read-only',
    '-C', turn.cwd,
    '-m', turn.model,
    '-c', `model_reasoning_effort=${JSON.stringify(turn.effort)}`,
    '-c', `developer_instructions=${JSON.stringify(codexInstructions(turn))}`,
    '-c', 'skills.include_instructions=false',
    '-c', 'skills.bundled.enabled=false',
    '-c', `web_search=${turn.web ? '"live"' : '"disabled"'}`,
    '-c', 'project_doc_max_bytes=0',
    '-c', NO_PERMISSIONS_TEXT,
    ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
    ...provider,
    ...gateway,
    '-'
  ]
}

export function codexParser(): Parser {
  let text = ''
  let finished = false

  return {
    line(line) {
      const ev = parseJson(line)
      if (!ev) return []
      const out: EngineEvent[] = []
      const type = ev['type']

      if (type === 'item.completed') {
        const item = ev['item'] as Record<string, unknown> | undefined
        if (item?.['type'] === 'web_search') {
          const action = (item['action'] ?? {}) as Record<string, unknown>
          const url = typeof action['url'] === 'string' ? action['url'] : undefined
          if (url) out.push({ type: 'web', action: 'fetch', detail: url })
          else out.push({ type: 'web', action: 'search', detail: String(item['query'] ?? action['query'] ?? '') })
        } else if (item?.['type'] === 'agent_message' && typeof item['text'] === 'string') {
          const delta = text ? `\n\n${item['text']}` : item['text']
          text += delta
          out.push({ type: 'text', delta })
        }
      } else if (type === 'turn.completed') {
        finished = true
        const u = (ev['usage'] ?? {}) as Record<string, unknown>
        const usage = {
          inputTokens: num(u['input_tokens']),
          cacheReadTokens: num(u['cached_input_tokens']),
          outputTokens: num(u['output_tokens'])
        }
        out.push({ type: 'progress', tokens: usage.inputTokens + usage.outputTokens, cacheRead: usage.cacheReadTokens })
        out.push({ type: 'done', text, usage })
      } else if (type === 'turn.failed' || type === 'error') {
        finished = true
        const err = ev['error'] as Record<string, unknown> | undefined
        const message = (typeof err?.['message'] === 'string' && err['message']) || (typeof ev['message'] === 'string' && ev['message']) || L('O Codex terminou com erro.', 'Codex ended with an error.')
        out.push({ type: 'error', message })
      }
      return out
    },
    end(code, stderr) {
      if (finished) return []
      const detail = lastLines(stderr)
      return [{ type: 'error', message: L(`O Codex saiu sem resposta (código ${code ?? '?'}).`, `Codex exited without a reply (code ${code ?? '?'}).`) + (detail ? `\n${detail}` : '') }]
    }
  }
}

// The same isolation as codexArgs, for `codex app-server`: what's the same for every thread goes in
// the process's flags; the rest (model, effort, instructions, folder, web, the gateway) in each
// thread's settings (web search on or off always said there), sent over stdin, so the gateway's
// address and its token never show in the arguments. The app-server has no --ignore-user-config or --ignore-rules: see codexIsolated.
// mcp_optional_startup_grace_ms=0: since Codex 0.147 a turn may start before an MCP server is up,
// and then goes without its tools; this waits for the gateway (local, quick to answer).
export function codexAppArgs(provider: string[] = []): string[] {
  return [
    'app-server',
    ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
    '-c', 'sandbox_mode="read-only"',
    '-c', 'approval_policy="never"',
    '-c', NO_PERMISSIONS_TEXT,
    '-c', 'skills.include_instructions=false',
    '-c', 'skills.bundled.enabled=false',
    '-c', 'project_doc_max_bytes=0',
    '-c', 'history.persistence="none"',
    '-c', 'mcp_optional_startup_grace_ms=0',
    ...provider
  ]
}

export function codexThread(turn: TurnShape): Record<string, unknown> {
  return {
    model: turn.model,
    cwd: turn.cwd,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    developerInstructions: codexInstructions(turn),
    config: {
      model_reasoning_effort: turn.effort,
      web_search: turn.web ? 'live' : 'disabled',
      ...(turn.mcpUrl ? { [`mcp_servers.${GATEWAY_NAME}`]: { url: turn.mcpUrl, default_tools_approval_mode: 'approve', tool_timeout_sec: 900 } } : {})
    }
  }
}

// What --ignore-user-config and --ignore-rules leave out, absent from the home: then the
// app-server loads nothing exec wouldn't. With either there, Codex runs as exec.
export const codexIsolated = (codexHome: string): boolean => !existsSync(join(codexHome, 'config.toml')) && !existsSync(join(codexHome, 'rules'))

// Each turn as one `codex exec` (the CLI before the app-server, or a home that has its own
// config): it gets the whole conversation every time.
const EXEC_ONLY = 'TUCANO_CODEX_EXEC'

export function codexEngine(
  bin: () => string | undefined,
  home: string,
  shellEnv: () => Promise<NodeJS.ProcessEnv> = async () => ({}),
  provider: () => Promise<CodexProvider & { env?: Record<string, string> }> = async () => userCodexProvider()
): Engine {
  const codexHome = (account?: string): string => join(account ?? home, '.codex')
  const notIsolated = new Set<string>() // homes found with a config of their own
  const isolated = (account?: string): boolean => {
    const h = codexHome(account)
    if (codexIsolated(h)) return true
    notIsolated.add(h)
    return false
  }
  // The gateway's key lives in the user's shell (.zshrc), which an app opened from Finder doesn't get.
  const launch = async (t: Pick<TurnShape, 'account'>): Promise<{ env: NodeJS.ProcessEnv; config: string[]; launch: Launch }> => {
    const p = await provider()
    const shell = await shellEnv() // read once per launch
    const keys = Object.fromEntries(p.envNames.flatMap((n) => (shell[n] ? [[n, shell[n]]] : [])))
    const env = { ...codexEnv(t.account ?? home, bin()), ...keys, ...p.env }
    return { env, config: p.config, launch: { key: JSON.stringify([t.account ?? home, p.config, keys, p.env ?? {}]), home: codexHome(t.account), args: codexAppArgs(p.config), env, cwd: t.account ?? home } }
  }
  const app = new CodexApp({ thread: codexThread })
  const appLaunch = async (t: Pick<TurnShape, 'account'>): Promise<Launch> => (await launch(t)).launch
  // Whether this turn can go to the app-server: one that resumes a session has to.
  const usable = (path: string, account?: string): boolean => !process.env[EXEC_ONLY] && app.supports(path) && isolated(account)

  const exec = (path: string, turn: Turn, l: { env: NodeJS.ProcessEnv; config: string[] }): AsyncIterable<EngineEvent> =>
    runCli({ bin: path, args: codexArgs(turn, l.config), stdin: turn.prompt, cwd: turn.cwd, signal: turn.signal, parser: codexParser(), env: l.env })

  return {
    id: 'codex',
    // Sessions only while every turn can go to the app-server; otherwise each gets the whole conversation.
    get sessions() {
      const path = bin()
      return !!path && !notIsolated.size && usable(path)
    },
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: L('O Codex não está instalado. Veja em Configurações.', "Codex isn't installed. See Settings.") }
        return
      }
      const l = await launch(turn)
      if (!usable(path, turn.account)) {
        if (turn.session?.resume) {
          yield { type: 'error', message: L('O Codex não tem mais essa conversa; ela recomeça na próxima resposta.', "Codex no longer has this conversation; it starts over on the next reply.") }
          return
        }
        yield* exec(path, turn, l)
        return
      }
      const session = turn.session
      const events = session ? app.session(path, { ...turn, session }, l.launch) : app.oneShot(path, turn, l.launch)
      let any = false
      try {
        for await (const ev of events) {
          any = true
          yield ev
        }
      } catch (e) {
        if (!(e instanceof Unsupported) || any) throw e
        // No app-server to take it (an old CLI): exec does, with everything, and from now on. A
        // session's first turn only then: the next would come with only what's new.
        if (session && app.supports(path)) {
          yield { type: 'error', message: e.message }
          return
        }
        yield* exec(path, turn, l)
      }
    },
    warm(turn) {
      const path = bin()
      if (!path || !usable(path, turn.account)) return
      void appLaunch(turn).then((l) => app.warm(path, turn, l), () => {})
    },
    rewarm(id) {
      const path = bin()
      if (path) app.rewarm(path, id, appLaunch)
    },
    release(id) {
      app.release(bin(), id, appLaunch)
    },
    clean(workDir, accountDirs = []) {
      app.clean(bin(), workDir, [home, ...accountDirs].map((h) => codexHome(h)), (h) => ({ key: JSON.stringify(['clean', h]), home: h, args: codexAppArgs(), env: codexEnv(join(h, '..'), bin()), cwd: join(h, '..') }))
    },
    settle: () => app.settle(),
    dispose: () => app.dispose()
  }
}
