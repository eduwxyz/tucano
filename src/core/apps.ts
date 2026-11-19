// The person's own apps (Notes, Calendar, Mail…), used by an agent the way a person
// would, through the system's accessibility tree, with agent-desktop
// (github.com/vercel-labs/agent-desktop). The agent reads an app as a short numbered
// list, then clicks and writes by number or by the text it sees; nothing moves the
// mouse or takes the focus. It only sees the apps the person gave it, each to read or
// to read and change; a click that sends, pays, publishes or deletes becomes an
// approval request, like the browser's.
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { L } from '../shared/lang'
import type { Agent, AgentApp } from '../shared/types'
import { textResult, type ToolDef } from './gateway'
import { norm, risky } from './browser'
import { findOnPath, spawnable } from './platform'
import { appOfWindow, launcherDirs, startApp, windowsOpen, type SystemApp } from './apps-os'

export const APPS = 'apps' // the "connector" of app click approvals
export const APP_TOOL_NAMES = new Set(['apps_listar', 'app_abrir', 'app_ver', 'app_menu', 'app_clicar', 'app_escrever', 'app_tecla'])
const WRITE = new Set(['app_clicar', 'app_escrever', 'app_tecla'])
const MAX_LINES = 160
const PERMIT_MS = 30 * 60_000
// One approved action: the app and the element's name, or the key.
const permitKey = (app: string, a: Record<string, unknown>): string => `${norm(app)}|${typeof a['tecla'] === 'string' ? `key:${norm(a['tecla'])}` : norm(String(a['alvo'] ?? ''))}`

// agent-desktop prints one JSON envelope per command: { ok, data } or { ok: false, error }.
export type Envelope = {
  ok: boolean
  data?: Record<string, unknown>
  error?: {
    code?: string
    message?: string
    suggestion?: string
    disposition?: { retry?: string }
    recovery?: { retry_after_ms?: number }
    details?: { kind?: string }
  }
}
export type Cli = (args: string[], timeoutMs?: number) => Promise<Envelope>

export const desktopBin = (): string | undefined => findOnPath('agent-desktop')

export const SELF = /^(dev\.tucano|com\.github\.electron)/i // Tucano itself isn't one of the apps to give

// Opens a Mac app with Chromium's accessibility on; false when the system doesn't know it
// (agent-desktop's launch tries next). `open -a` knows only the bundle's own name ("Notes"),
// so a shown name in the person's language ("Notas") goes by its bundle id.
export async function openMac(app: string): Promise<boolean> {
  const id = await bundleOf(app)
  return new Promise((resolve) =>
    execFile('open', [...(id ? ['-b', id] : ['-a', app]), '--args', '--force-renderer-accessibility'], { timeout: 15_000 }, (err) => resolve(!err))
  )
}

async function bundleOf(app: string): Promise<string | undefined> {
  const same = (a: { name: string }): boolean => norm(a.name) === norm(app)
  return (await macOpenApps().catch(() => [])).find(same)?.bundleId ?? (await macApps().catch(() => [])).find(same)?.bundleId
}

// Types text key by key into the app's focused field: letters, digits, spaces and common
// punctuation. With anything else it types nothing and says so, or the field would get part of it.
const KEYNAME: Record<string, string> = { ' ': 'space', ',': 'comma', '.': 'period', '/': 'slash', ';': 'semicolon', "'": 'quote', '-': 'minus', '=': 'equal' }
const keyOf = (ch: string): string | undefined => (/^[a-z0-9]$/.test(ch) ? ch : /^[A-Z]$/.test(ch) ? `shift+${ch.toLowerCase()}` : KEYNAME[ch])

export async function typeKeys(cli: Cli, app: string, text: string): Promise<Envelope> {
  const missing = [...new Set([...text].filter((ch) => !keyOf(ch)))]
  if (missing.length) return { ok: false, error: { message: L(`Não dá pra digitar ${missing.join(' ')} tecla por tecla. Escreva no campo sem digitar.`, `${missing.join(' ')} can't be typed key by key. Write in the field without typing.`) } }
  for (const ch of text) {
    const r = await cli(['press', keyOf(ch)!, '--app', app], 10_000)
    if (!r.ok) return r
  }
  return { ok: true }
}

// The Mac's open apps: lsappinfo lists each with its name, bundle id and type.
export async function macOpenApps(): Promise<{ name: string; bundleId?: string }[]> {
  const out = await new Promise<string>((resolve) => execFile('lsappinfo', ['list'], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (_e, stdout) => resolve(String(stdout ?? ''))))
  return parseLsappinfo(out)
}

export function parseLsappinfo(out: string): { name: string; bundleId?: string }[] {
  return out
    .split(/\n(?=\s*\d+\) ")/)
    .filter((b) => /type="Foreground"/.test(b))
    .flatMap((b) => {
      const name = clean(/^\s*\d+\) "([^"]*)"/.exec(b)?.[1])
      const id = /bundleID="([^"]*)"/.exec(b)?.[1]
      return name ? [{ name: name.normalize('NFC'), ...(id ? { bundleId: id } : {}) }] : []
    })
}

// The Mac's installed apps, with their localized names (Spotlight's display name).
export async function macApps(): Promise<{ name: string; bundleId?: string; path: string }[]> {
  if (process.platform !== 'darwin') return []
  const dirs = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', join(homedir(), 'Applications')]
  const paths = ['/System/Library/CoreServices/Finder.app', ...dirs.flatMap((d) => {
    try {
      return readdirSync(d).filter((f) => f.endsWith('.app')).map((f) => join(d, f))
    } catch {
      return []
    }
  })]
  type MacApp = { name: string; bundleId?: string; path: string }
  const mdls = (batch: string[]): Promise<string> =>
    new Promise((resolve) => execFile('mdls', ['-name', 'kMDItemCFBundleIdentifier', '-name', 'kMDItemDisplayName', '-raw', ...batch], { timeout: 10_000 }, (_e, stdout) => resolve(String(stdout ?? ''))))
  // Many apps per mdls (one process each took seconds). It stops at an app Spotlight can't
  // read: that one goes by its file's name, and the rest are asked again.
  const read = async (batch: string[]): Promise<MacApp[]> => {
    if (!batch.length) return []
    const apps = parseMdls(await mdls(batch), batch)
    if (apps?.length === batch.length) return apps
    if (!apps) return (await Promise.all(batch.map((p) => (batch.length > 1 ? read([p]) : [{ name: basename(p, '.app'), path: p }])))).flat()
    const stuck = batch[apps.length]!
    return [...apps, { name: basename(stuck, '.app'), path: stuck }, ...(await read(batch.slice(apps.length + 1)))]
  }
  const batches: string[][] = []
  for (let i = 0; i < paths.length; i += 40) batches.push(paths.slice(i, i + 40))
  const out = (await Promise.all(batches.map(read))).flat()
  // The same app in two places (~/Applications and /Applications): once.
  return out.filter((a, i) => !a.bundleId || out.findIndex((b) => b.bundleId === a.bundleId) === i)
}

// What `mdls -raw` prints for several apps: two values each (bundle id, then name), split by NULs.
// Fewer apps than asked when it stopped at one it couldn't read; undefined when the values don't
// pair up, so one app's answer can't be told from the next one's.
export function parseMdls(stdout: string, paths: string[]): { name: string; bundleId?: string; path: string }[] | undefined {
  // Its complaint comes on stdout too, glued to the last value: "<first path>: could not find <path>."
  const complaint = stdout.lastIndexOf(`${paths[0]}: could not find `)
  const text = complaint >= 0 ? stdout.slice(0, complaint) : stdout
  const values = text === '' ? [] : text.split('\0').map((v) => clean(v))
  if (values.length % 2 || values.length > paths.length * 2) return undefined
  return paths.slice(0, values.length / 2).map((path, i) => {
    const id = values[i * 2] ?? ''
    const shown = (values[i * 2 + 1] ?? '').normalize('NFC').replace(/\.app$/, '')
    return { name: shown && shown !== '(null)' ? shown : basename(path, '.app'), ...(id && id !== '(null)' ? { bundleId: id } : {}), path }
  })
}

export function agentDesktop(bin: () => string | undefined = desktopBin): Cli {
  return (args, timeoutMs = 45_000) =>
    new Promise((resolve) => {
      const path = bin()
      if (!path)
        return resolve({
          ok: false,
          error: {
            code: 'NOT_INSTALLED',
            message: L('O agent-desktop não está instalado.', "agent-desktop isn't installed.")
          }
        })
      const s = spawnable(path, args)
      execFile(
        s.file,
        s.args,
        {
          timeout: timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
          windowsVerbatimArguments: s.verbatim
        },
        (_err, stdout, stderr) => {
          try {
            resolve(JSON.parse(String(stdout)) as Envelope)
          } catch {
            resolve({
              ok: false,
              error: {
                code: 'BAD_OUTPUT',
                message: (String(stderr) || String(stdout)).trim().slice(0, 300) || L('sem resposta', 'no answer')
              }
            })
          }
        }
      )
    })
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Runs a command, again when agent-desktop says that's safe (an app still opening, an
// inventory that hadn't settled), at most three times.
export async function run(cli: Cli, args: string[], opts: { tries?: number; pause?: (ms: number) => Promise<void> } = {}): Promise<Envelope> {
  const tries = opts.tries ?? 3
  let out: Envelope = { ok: false }
  for (let i = 0; i < tries; i++) {
    out = await cli(args)
    if (out.ok || out.error?.disposition?.retry !== 'safe' || i === tries - 1) return out
    await (opts.pause ?? wait)(Math.min(Math.max(out.error?.recovery?.retry_after_ms ?? 400, 250), 2_000))
  }
  return out
}

export const failure = (e: Envelope): string => [e.error?.message, e.error?.suggestion].filter(Boolean).join(' ') || L('falhou', 'failed')

// ---------- the numbered list the agent reads ----------

export interface Item {
  n: number
  ref: string
  role: string
  name: string
  value?: string
  actions?: string[]
}
interface Node {
  role?: string
  name?: string
  value?: unknown
  ref_id?: string
  available_actions?: string[]
  children?: Node[]
}

// A row with no name of its own (a list of notes, of messages) goes by what's in it.
const inner = (n: Node): string => {
  for (const c of n.children ?? []) {
    const t = clean(c.name) || inner(c)
    if (t) return t
  }
  return ''
}

const ROLE = (): Record<string, string> => ({
  button: L('botão', 'button'),
  menuitem: L('item de menu', 'menu item'),
  menubaritem: 'menu',
  textfield: L('campo', 'field'),
  textarea: L('campo de texto', 'text area'),
  checkbox: L('caixa', 'checkbox'),
  radiobutton: L('opção', 'option'),
  link: 'link',
  row: L('linha', 'row'),
  cell: L('célula', 'cell'),
  tab: L('aba', 'tab'),
  popupbutton: L('menu', 'menu'),
  combobox: L('lista', 'list'),
  slider: L('controle', 'slider'),
  statictext: L('texto', 'text'),
  // Windows' and Linux's names for the same things.
  option: L('item', 'item'),
  listitem: L('item', 'item'),
  menubutton: L('botão de menu', 'menu button'),
  document: L('documento', 'document'),
  listbox: L('lista', 'list'),
  menu: 'menu'
})
const clean = (s: unknown): string =>
  String(s ?? '')
    .replace(/[‎‏‪-‮]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

// The tree as numbered lines: everything the agent can act on, and the text around it
// (a note's lines, a field's value), so it can read the app too.
// `from` skips that many lines (a later page of a big window, numbers unchanged); `start` numbers
// after an earlier list, so an area read keeps the window's numbers good.
export function itemize(tree: Node | undefined, max = MAX_LINES, from = 0, start = 0): { items: Item[]; lines: string[]; more: number } {
  const items: Item[] = []
  const lines: string[] = []
  let more = 0
  let seen = 0
  const show = (line: string, item: boolean): void => {
    if (seen >= from && lines.length < max) lines.push(line)
    else if (item && seen >= from) more++
    seen++
  }
  const visit = (n: Node, depth: number): void => {
    const role = String(n.role ?? '')
    const name = clean(n.name) || (['row', 'option', 'listitem', 'cell'].includes(role) ? inner(n) : '')
    const value = typeof n.value === 'string' || typeof n.value === 'number' ? clean(n.value) : ''
    if (n.ref_id) {
      const item: Item = {
        n: start + items.length + 1,
        ref: n.ref_id,
        role,
        name,
        ...(value && value !== name ? { value } : {}),
        ...(n.available_actions?.length ? { actions: n.available_actions } : {})
      }
      items.push(item)
      show(`${'  '.repeat(Math.min(depth, 4))}#${item.n} ${ROLE()[role] ?? role}${name ? ` "${name}"` : ''}${item.value ? ` = "${item.value.slice(0, 200)}"` : ''}`, true)
    } else if (role === 'statictext' && (name || value)) show(`${'  '.repeat(Math.min(depth, 4))}${L('texto', 'text')} "${(name || value).slice(0, 200)}"`, false)
    for (const c of n.children ?? []) visit(c, depth + 1)
  }
  if (tree) visit(tree, 0)
  return { items, lines, more }
}

// "#12", "12", or the text of an element in the last list (exact first, then the only one that contains it).
export function pick(target: string, items: Item[]): Item | { error: string } {
  const t = target.trim()
  const num = /^#?\s*(\d+)$/.exec(t)
  if (num) {
    const hit = items.find((i) => i.n === Number(num[1]))
    return (
      hit ?? {
        error: L(`Não existe o #${num[1]} na última lista. Leia o app de novo com app_ver.`, `There's no #${num[1]} in the last list. Read the app again with app_ver.`)
      }
    )
  }
  const want = norm(t)
  const exact = items.filter((i) => norm(i.name) === want)
  if (exact.length) return exact[0]!
  const part = items.filter((i) => i.name && norm(i.name).includes(want))
  if (part.length === 1) return part[0]!
  if (part.length > 1)
    return {
      error: L(
        `"${t}" bate com vários: ${part
          .slice(0, 6)
          .map((i) => `#${i.n} "${i.name}"`)
          .join(', ')}. Use o número.`,
        `"${t}" matches several: ${part
          .slice(0, 6)
          .map((i) => `#${i.n} "${i.name}"`)
          .join(', ')}. Use the number.`
      )
    }
  return {
    error: L(
      `Não achei "${t}" na última lista. Leia o app com app_ver (ou app_menu, pros menus) e use o número.`,
      `Couldn't find "${t}" in the last list. Read the app with app_ver (or app_menu, for the menus) and use the number.`
    )
  }
}

// Tucano itself (or Electron, while developing) is never an app an agent drives: it could
// click its own approval.
export const isTucano = (a: { name: string; bundleId?: string }): boolean => /^(tucano|tucano dev|electron)(\.exe)?$/i.test(a.name.trim()) || /^dev\.tucano\./i.test(a.bundleId ?? '') || /^com\.github\.electron/i.test(a.bundleId ?? '')

// The app the agent named, among those it was given (by name, ignoring case and accents).
export function grantOf(agent: Pick<Agent, 'apps'>, app: string): AgentApp | undefined {
  const want = norm(app)
  return (agent.apps ?? []).find((a) => norm(a.name) === want)
}

// A key that can send (Return in a chat, ⌘↩ in Mail) asks first.
// A key that can send (Return in a chat, ⌘↩ in Mail) or delete in bulk (⌘⌫) asks first.
// Desktop apps name the act of scheduling by what it makes ("Novo Evento"), not by a verb.
const CREATES = /\b(nov[oa]|criar|crie|new|create)\s+(evento|event|reuniao|meeting|compromisso|appointment)\b/
// One with no name can't be judged by it, so it asks too.
export const riskyClick = (name: string): boolean => !norm(name).trim() || risky(name) || CREATES.test(norm(name))

// A shortcut as the system takes it: off a Mac, ⌘ is Ctrl (agent-desktop reads "cmd" as the
// Windows or Super key) and ⌥ is Alt.
export const keyFor = (combo: string, platform: NodeJS.Platform = process.platform): string => {
  const c = combo.replace(/\s+/g, '').toLowerCase()
  return platform === 'darwin' ? c : c.replace(/\b(cmd|command|meta)\+/g, 'ctrl+').replace(/\boption\+/g, 'alt+')
}

// The modifiers count in any order: shift+cmd+d is cmd+shift+d.
export const riskyKey = (combo: string): boolean => {
  const parts = combo.replace(/\s+/g, '').toLowerCase().split('+')
  const key = parts.pop() ?? ''
  const mods = new Set(parts.map((m) => ({ command: 'cmd', meta: 'cmd', control: 'ctrl', option: 'alt' })[m] ?? m))
  const cmd = mods.has('cmd') || mods.has('ctrl')
  if (key === 'return' || key === 'enter') return mods.size === 0 || cmd
  if (key === 'd') return cmd && mods.has('shift')
  if (key === 'backspace' || key === 'delete') return cmd || mods.has('alt')
  return false
}

// ---------- the tools ----------

export function appTools(agent: Pick<Agent, 'apps'>): ToolDef[] {
  const names = (agent.apps ?? []).map((a) => a.name)
  const app = {
    type: 'string',
    description: L(`O app, pelo nome: ${names.join(', ')}.`, `The app, by name: ${names.join(', ')}.`)
  }
  const alvo = {
    type: 'string',
    description: L('O número do elemento na última lista (#12) ou o texto dele.', "The element's number in the last list (#12) or its text.")
  }
  const writes = (agent.apps ?? []).some((a) => a.level === 'read_write')
  return [
    {
      name: 'apps_listar',
      description: L(
        'Lista os apps do computador que você pode usar, se estão abertos, e se pode só ler ou também mexer.',
        'Lists the computer apps you may use, whether they are open, and whether you may only read them or also change things.'
      ),
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'app_abrir',
      description: L('Abre um app (ou traz o que já está aberto) e espera a janela.', 'Opens an app (or picks the one already open) and waits for its window.'),
      inputSchema: { type: 'object', properties: { app }, required: ['app'] }
    },
    {
      name: 'app_ver',
      description: L(
        'Lê a janela do app: a lista numerada do que dá pra clicar ou preencher, e os textos. Numa janela grande, passe area com o número de um grupo pra ler só ele.',
        "Reads the app's window: the numbered list of what can be clicked or filled in, and its texts. In a big window, pass area with a group's number to read only that."
      ),
      inputSchema: {
        type: 'object',
        properties: {
          app,
          area: {
            type: 'string',
            description: L('Opcional: o número de um grupo da última lista.', "Optional: a group's number from the last list.")
          },
          pagina: {
            type: 'number',
            description: L(`Opcional: numa janela grande, a página da lista (${MAX_LINES} linhas cada, a 1 é o começo). Os números não mudam de uma página pra outra.`, `Optional: in a big window, the page of the list (${MAX_LINES} lines each, 1 is the start). Numbers stay the same across pages.`)
          }
        },
        required: ['app']
      }
    },
    {
      name: 'app_menu',
      description: L(
        'Lê a barra de menus do app (Arquivo, Editar…), numerada: muitos comandos, como "Nova Nota", estão lá.',
        'Reads the app\'s menu bar (File, Edit…), numbered: many commands, like "New Note", live there.'
      ),
      inputSchema: { type: 'object', properties: { app }, required: ['app'] }
    },
    ...(writes ? changeTools(app, alvo) : [])
  ]
}

function changeTools(app: Record<string, unknown>, alvo: Record<string, unknown>): ToolDef[] {
  return [
    {
      name: 'app_clicar',
      description: L(
        'Clica num elemento do app. Botão que envia, paga, publica ou apaga vira um pedido de aprovação.',
        'Clicks an element of the app. A button that sends, pays, publishes or deletes becomes an approval request.'
      ),
      inputSchema: {
        type: 'object',
        properties: {
          app,
          alvo,
          botao_direito: {
            type: 'boolean',
            description: L('Clique direito: abre o menu do elemento (apagar, mover, duplicar um item de lista); a resposta é esse menu, numerado.', "Right click: opens the element's own menu (delete, move, duplicate a list item); the answer is that menu, numbered.")
          },
          motivo: {
            type: 'string',
            description: L('Por que, em uma frase (aparece no pedido de aprovação).', 'Why, in one sentence (shows in the approval request).')
          }
        },
        required: ['app', 'alvo']
      }
    },
    {
      name: 'app_escrever',
      description: L('Escreve num campo do app, trocando o que estava lá.', 'Writes into a field of the app, replacing what was there.'),
      inputSchema: {
        type: 'object',
        properties: {
          app,
          alvo,
          texto: { type: 'string' },
          teclando: {
            type: 'boolean',
            description: L('Digita tecla por tecla, como uma pessoa: pra campos que ignoram o texto colado (a busca do Spotify, por exemplo).', 'Types key by key, like a person: for fields that ignore pasted text (Spotify’s search, for one).')
          }
        },
        required: ['app', 'alvo', 'texto']
      }
    },
    {
      name: 'app_tecla',
      description: L(
        'Aperta uma tecla ou atalho no app (escape, tab, cmd+n…). Return e atalhos de enviar pedem aprovação.',
        'Presses a key or shortcut in the app (escape, tab, cmd+n…). Return and send shortcuts ask for approval.'
      ),
      inputSchema: {
        type: 'object',
        properties: { app, tecla: { type: 'string' }, motivo: { type: 'string', description: L('Por que, em uma frase (aparece no pedido de aprovação).', 'Why, in one sentence (shows in the approval request).') } },
        required: ['app', 'tecla']
      }
    }
  ]
}

const DONE = (): Record<string, string> => ({
  apps_listar: L('Viu os apps', 'Checked the apps'),
  app_abrir: L('Abriu', 'Opened'),
  app_ver: L('Leu', 'Read'),
  app_menu: L('Leu os menus de', 'Read the menus of'),
  app_clicar: L('Clicou em', 'Clicked'),
  app_escrever: L('Escreveu em', 'Typed in'),
  app_tecla: L('Apertou', 'Pressed')
})
export function appStep(name: string, args: Record<string, unknown>): { label: string; detail: string } {
  const s = (k: string): string => String(args[k] ?? '').trim()
  const detail = name === 'app_clicar' || name === 'app_escrever' ? `${s('alvo')} · ${s('app')}` : name === 'app_tecla' ? `${s('tecla')} · ${s('app')}` : s('app')
  return { label: DONE()[name] ?? name, detail }
}

export interface AppOutcome {
  result: CallToolResult
  detail?: string
  approval?: { args: Record<string, unknown>; why: string; detail: string }
}

// The apps of every agent: the last numbered list each one read, and the actions.
// The agents' own Chrome (chrome.ts) runs headless but still sits on Linux's accessibility bus
// as "chrome", next to the person's: agent-desktop picks it by name unless told the window.
// shortcut: recognized by its --remote-debugging-pipe, which a person's Chrome never has; pass the pid list from chrome.ts if that changes.
export const isAgentBrowser = (cmdline: string): boolean => cmdline.split('\0').includes('--remote-debugging-pipe')
const agentBrowserPid = (pid: number): boolean => {
  try {
    return isAgentBrowser(readFileSync(`/proc/${pid}/cmdline`, 'utf8'))
  } catch {
    return false
  }
}
const exeOf = (pid: number): string | undefined => {
  try {
    return readlinkSync(`/proc/${pid}/exe`)
  } catch {
    return undefined
  }
}
type Win = { id?: string; pid?: number; is_focused?: boolean; bounds?: { width?: number; height?: number }; size?: { width?: number; height?: number } }
const area = (x: Win): number => (x.bounds?.width ?? x.size?.width ?? 0) * (x.bounds?.height ?? x.size?.height ?? 0)
// The node a ref was given to, in a tree already read.
const nodeOf = (n: Node, ref: string): Node | undefined => (n.ref_id === ref ? n : (n.children ?? []).reduce<Node | undefined>((hit, c) => hit ?? nodeOf(c, ref), undefined))
const biggest = (list: Win[]): Win | undefined => [...list].sort((a, b) => area(b) - area(a))[0]

export class DesktopApps {
  private lists = new Map<string, { app: string; items: Item[]; surface: string; tree?: Node; title?: string }>() // the last numbered list per agent, where it came from, and the whole tree it was cut from
  private permits = new Map<string, { key: string; until: number }[]>() // approved actions, each good once
  private written = new Map<string, { app: string; text: string; creates?: boolean }>() // the last thing each agent wrote, and where

  private targets = new Map<string, { name: string; at: number }>() // an app's name for agent-desktop, a minute at a time
  private platform: NodeJS.Platform
  private installed: () => Promise<SystemApp[]>
  private agentBrowser: (pid: number) => boolean
  private exe: (pid: number) => string | undefined
  private wayland: boolean
  // Linux reads a web page (Chrome, Electron) until three reads agree; a big one takes more than
  // agent-desktop's 3 s, and a window not read whole leaves every element unproven (AMBIGUOUS_TARGET).
  private slow: string[]
  private dirs: (program: string) => string[]

  constructor(
    private cli: Cli = agentDesktop(),
    opts: { platform?: NodeJS.Platform; installed?: () => Promise<SystemApp[]>; agentBrowser?: (pid: number) => boolean; exe?: (pid: number) => string | undefined; dirs?: (program: string) => string[]; wayland?: boolean } = {}
  ) {
    this.platform = opts.platform ?? process.platform
    this.installed = opts.installed ?? (async () => [])
    this.agentBrowser = opts.agentBrowser ?? ((pid) => this.platform === 'linux' && agentBrowserPid(pid))
    this.exe = opts.exe ?? exeOf
    this.dirs = opts.dirs ?? launcherDirs
    // The session's own variables only for the real platform (tests pick theirs).
    this.wayland = opts.wayland ?? (!opts.platform && this.platform === 'linux' && (process.env['XDG_SESSION_TYPE'] === 'wayland' || !!process.env['WAYLAND_DISPLAY']))
    this.slow = this.platform === 'linux' ? ['--timeout-ms', '15000'] : []
  }

  // The app's windows, without the agents' own Chrome; `hidden` when it had one there.
  private async windowsOf(who: string): Promise<{ list: Win[]; hidden: boolean }> {
    const w = await this.cli(['list-windows', '--app', who], 15_000)
    const all = (Array.isArray(w.data) ? w.data : ((w.data?.['windows'] as unknown[]) ?? [])) as Win[]
    const list = all.filter((x) => !(x.pid && this.agentBrowser(x.pid)))
    return { list, hidden: list.length < all.length }
  }

  // Off a Mac, when the agents' Chrome shares the app's name: the person's window, so keys and focus go there.
  private async only(who: string): Promise<string[]> {
    if (this.platform !== 'linux') return []
    const { list, hidden } = await this.windowsOf(who)
    const main = biggest(list)
    return hidden && main?.id ? ['--window-id', main.id] : []
  }

  private async installedApp(app: string): Promise<SystemApp | undefined> {
    return (await this.installed().catch(() => [])).find((a) => norm(a.name) === norm(app))
  }

  // Windows and Linux: an app already open comes forward; one that isn't starts the way the
  // system's menu starts it.
  private async openOther(app: string, ia: SystemApp): Promise<boolean> {
    const open = (await this.foreground().catch(() => [])).some((a) => norm(a.name) === norm(app))
    if (open) {
      const who = await this.target(app, true)
      await run(this.cli, ['focus-window', '--app', who, ...(await this.only(who))])
      return true
    }
    return startApp(ia, this.platform)
  }

  // The name agent-desktop knows an app by. On a Mac, the one the person sees ("Notas");
  // on Windows and Linux, its program's ("notepad", "gnome-text-editor"), found through
  // the open windows and the installed apps.
  async target(app: string, fresh = false): Promise<string> {
    if (this.platform === 'darwin') return app
    const known = this.targets.get(norm(app))
    if (!fresh && known && Date.now() - known.at < 60_000) return known.name
    const ia = await this.installedApp(app)
    let name: string | undefined
    if (this.platform === 'win32') {
      const all = await this.installed().catch(() => [])
      const w = (await windowsOpen().catch(() => [])).find((x) => norm(appOfWindow(x, all)?.name ?? x.desc ?? x.name) === norm(app) || norm(x.name) === norm(app))
      name = w?.name ?? (ia?.exe && !ia.id?.includes('!') ? (ia.exe.split('\\').pop() ?? '').replace(/\.exe$/i, '') : undefined)
    } else {
      const r = await this.cli(['list-apps'], 20_000)
      const apps = ((r.data?.['apps'] ?? []) as { name?: string; bundle_id?: string; pid?: number; presentation?: string }[]).filter((a) => a.name && !(a.pid && this.agentBrowser(a.pid)))
      const prog = ia?.exec?.[0]?.split('/').pop()
      const byId = ia?.id ? apps.find((a) => a.bundle_id === `${ia.id}.desktop` || a.bundle_id === ia.id) : undefined
      name = (byId ?? apps.find((a) => (prog && a.name === prog) || norm(a.name!) === norm(app)))?.name
      // A launcher script under another name (google-chrome-stable starts "chrome"): by where the running program lives.
      const launcher = ia?.exec?.[0] && (ia.exec[0].includes('/') ? ia.exec[0] : findOnPath(ia.exec[0]))
      if (!name && launcher) {
        const dirs = this.dirs(launcher)
        name = apps.find((a) => {
          const exe = a.pid && a.presentation === 'foreground' ? this.exe(a.pid) : undefined
          return !!exe && dirs.includes(dirname(exe))
        })?.name
      }
      if (!name && ia) name = prog && !/^(flatpak|env|snap|sh|bash)$/.test(prog) ? prog : ia.id
    }
    const out = name || app
    this.targets.set(norm(app), { name: out, at: Date.now() })
    return out
  }

  async status(): Promise<{
    installed: boolean
    version?: string
    accessibility?: string
    suggestion?: string
  }> {
    const v = await this.cli(['version'], 15_000)
    if (!v.ok) return { installed: false }
    const p = await this.cli(['permissions'], 15_000)
    const a = p.data?.['accessibility'] as { state?: string; suggestion?: string } | undefined
    return {
      installed: true,
      version: String(v.data?.['version'] ?? ''),
      ...(a?.state ? { accessibility: a.state } : {}),
      ...(a?.suggestion ? { suggestion: a.suggestion } : {})
    }
  }

  // The system's privacy settings, at Accessibility.
  async guide(): Promise<void> {
    // Only a Mac has a settings page for it: Windows asks nothing, Linux needs its bus running.
    if (this.platform === 'darwin') await this.cli(['permissions', '--guide'], 30_000)
  }

  // The apps open right now, by name, for the person to pick from.
  // Only apps with windows: helpers and background services aren't apps to the person.
  async running(): Promise<string[]> {
    return [...new Set((await this.foreground()).map((a) => a.name))].sort((a, b) => a.localeCompare(b))
  }

  // The apps with windows right now (helpers and background services aren't apps to the person).
  // On a Mac the system answers at once (lsappinfo); agent-desktop's inventory can take seconds.
  async foreground(): Promise<{ name: string; bundleId?: string }[]> {
    if (this.platform === 'darwin') {
      const mac = (await macOpenApps().catch(() => [])).filter((a) => !isTucano(a))
      if (mac.length) return mac
    }
    const all = await this.installed().catch(() => [])
    const mine = (n: string): boolean => isTucano({ name: n })
    const once = (list: { name: string; bundleId?: string }[]): { name: string; bundleId?: string }[] => list.filter((a, i) => a.name && !mine(a.name) && list.findIndex((b) => b.name === a.name) === i)
    // Windows: the system's own list of windows answers at once; each by the name in the Start menu.
    if (this.platform === 'win32') {
      const wins = await windowsOpen().catch(() => [])
      if (wins.length)
        return once(wins.filter((w) => !mine(w.name)).map((w) => {
          const a = appOfWindow(w, all)
          return a ? { name: a.name, ...(a.id ? { bundleId: a.id } : {}) } : { name: w.desc || w.name }
        }))
    }
    const r = await run(this.cli, ['list-apps'])
    const apps = ((r.data?.['apps'] ?? []) as { name?: string; bundle_id?: string; presentation?: string; pid?: number }[]).filter((a) => !(a.pid && this.agentBrowser(a.pid)))
    // Linux: a program by its menu entry's name ("Editor de texto", not gnome-text-editor).
    // A Chromium app started by a script under another name (google-chrome-stable runs "chrome"): by where it lives.
    const byDir = new Map(this.platform === 'linux' ? all.filter((x) => x.chromium && x.exec?.[0]).flatMap((x) => this.dirs(x.exec![0]!.includes('/') ? x.exec![0]! : (findOnPath(x.exec![0]!) ?? x.exec![0]!)).map((d) => [d, x] as const)) : [])
    const shown = (a: { name?: string; bundle_id?: string; pid?: number }): { name: string; bundleId?: string } => {
      const id = a.bundle_id?.replace(/\.desktop$/, '')
      const exe = byDir.size && a.pid ? this.exe(a.pid) : undefined
      const entry = all.find((x) => (id && x.id === id) || x.exec?.[0]?.split('/').pop() === a.name) ?? (exe ? byDir.get(dirname(exe)) : undefined)
      return entry ? { name: entry.name, ...(entry.id ? { bundleId: entry.id } : {}) } : { name: clean(a.name), ...(a.bundle_id ? { bundleId: a.bundle_id } : {}) }
    }
    return once(apps.filter((a) => a.presentation === 'foreground' && clean(a.name)).map(shown))
  }

  // An app with several windows (a popover left open, a second document): its main one,
  // the biggest, unless a surface (a menu, a popover) was asked for.
  private async snapshot(app: string, extra: string[]): Promise<Envelope> {
    let who = await this.target(app)
    if (this.platform === 'linux' && !extra.includes('--surface')) {
      const { list, hidden } = await this.windowsOf(who)
      const main = biggest(list)
      if (hidden)
        return main?.id
          ? run(this.cli, ['snapshot', '--app', who, '-i', '--compact', '--window-id', main.id, ...extra, ...this.slow])
          : { ok: false, error: { code: 'WINDOW_NOT_FOUND', message: L(`a janela do ${app} não está aberta, ou ele foi aberto sem acessibilidade (feche e abra com app_abrir).`, `${app}'s window isn't open, or it was started without accessibility (close it and open it with app_abrir).`) } }
    }
    let r = await run(this.cli, ['snapshot', '--app', who, '-i', '--compact', ...extra, ...this.slow])
    // Opened or closed since: look for it again.
    if (!r.ok && this.platform !== 'darwin' && /APP_NOT_FOUND|WINDOW_NOT_FOUND/.test(r.error?.code ?? '')) {
      who = await this.target(app, true)
      r = await run(this.cli, ['snapshot', '--app', who, '-i', '--compact', ...extra, ...this.slow])
    }
    if (r.ok || r.error?.code !== 'AMBIGUOUS_TARGET' || extra.includes('--surface')) return r
    const main = biggest((await this.windowsOf(who)).list)
    return main?.id ? run(this.cli, ['snapshot', '--app', who, '-i', '--compact', '--window-id', main.id, ...extra, ...this.slow]) : r
  }

  private async read(agentId: string, app: string, extra: string[] = [], page = 1): Promise<CallToolResult> {
    const before = this.lists.get(agentId)
    const r = await this.snapshot(app, extra)
    const root = extra[extra.indexOf('--root') + 1]
    // Off a Mac an area that repeats in the window (a row of a table) has no ref of its own:
    // the area as it was in the last whole read, which already has it.
    const kept = !r.ok && r.error?.code === 'AMBIGUOUS_TARGET' && extra.includes('--root') && root && before?.tree && norm(before.app) === norm(app) ? nodeOf(before.tree, root) : undefined
    if (!r.ok && !kept) return textResult(L(`Não consegui ler o ${app}: ${failure(r)}`, `Couldn't read ${app}: ${failure(r)}`), true)
    const tree = kept ?? (r.data?.['tree'] as Node | undefined)
    // An area is numbered after the list it came from, and that list stays good: #127 still works after reading #130.
    const area = extra.includes('--root') && before && norm(before.app) === norm(app)
    const prior = area ? before.items : []
    const { items: found, lines, more } = itemize(tree, MAX_LINES, (Math.max(1, Math.floor(page)) - 1) * MAX_LINES, prior.reduce((m, i) => Math.max(m, i.n), 0))
    const items = [...prior, ...found]
    const win = kept ? before?.title : clean((r.data?.['window'] as { title?: string } | undefined)?.title)
    // An area keeps the whole tree it came from, so a group inside it can be read the same way.
    const whole = extra.includes('--root') ? before?.tree : tree
    this.lists.set(agentId, { app, items, surface: extra.includes('menu') ? 'menu' : extra.includes('menubar') ? 'menubar' : 'window', ...(whole ? { tree: whole } : {}), ...(win ? { title: win } : {}) })
    const head = `${app}${win && win !== app ? ` · ${win}` : ''}${kept ? L(' (da última leitura: esse grupo se repete na janela)', ' (from the last read: this group repeats in the window)') : ''}`
    const next = `${area ? `area=#${prior.find((i) => i.ref === root)?.n ?? ''} ` : ''}pagina=${Math.max(1, Math.floor(page)) + 1}`
    const tail = more ? `\n${L(`+${more} elementos não listados: veja os próximos com app_ver ${next}, ou leia um grupo com app_ver area=#n.`, `+${more} elements not listed: see the next ones with app_ver ${next}, or read a group with app_ver area=#n.`)}` : ''
    return textResult(`${head}\n${lines.join('\n') || L('(nada pra clicar nessa janela)', '(nothing to click in this window)')}${tail}`)
  }

  private item(agentId: string, app: string, target: string): Item | { error: string } {
    const last = this.lists.get(agentId)
    if (!last || norm(last.app) !== norm(app))
      return {
        error: L(`Leia o ${app} antes com app_ver ou app_menu.`, `Read ${app} first with app_ver or app_menu.`)
      }
    return pick(target, last.items)
  }

  async call(agent: Agent, name: string, args: Record<string, unknown>): Promise<AppOutcome> {
    const id = agent.id
    if (name === 'apps_listar') {
      const open = new Set((await this.running().catch(() => [])).map(norm))
      const list = (agent.apps ?? []).map(
        (a) => `- ${a.name}: ${a.level === 'read_write' ? L('ler e mexer', 'read and change') : L('só ler', 'read only')}${open.has(norm(a.name)) ? L(' · aberto', ' · open') : ''}`
      )
      return {
        result: textResult(list.join('\n') || L('Nenhum app liberado.', 'No apps given.'))
      }
    }
    const grant = grantOf(agent, String(args['app'] ?? ''))
    if (!grant) {
      const names = (agent.apps ?? []).map((a) => a.name).join(', ')
      return {
        result: textResult(L(`Esse app não está liberado pra você. Liberados: ${names || 'nenhum'}.`, `That app isn't given to you. Given: ${names || 'none'}.`), true)
      }
    }
    const app = grant.name
    if (isTucano({ name: app }))
      return {
        result: textResult(L('O Tucano não pode ser usado como app por um agente.', "Tucano can't be used as an app by an agent."), true)
      }
    if (WRITE.has(name) && grant.level !== 'read_write')
      return {
        result: textResult(L(`Você só pode ler o ${app}.`, `You may only read ${app}.`), true)
      }

    switch (name) {
      case 'app_abrir': {
        // On a Mac, apps made with Chromium (Spotify, Slack, Discord…) show their screen to
        // accessibility only when started with it on; the flag does nothing to the others.
        // `open -a` also brings an app already open to the front, under its own (localized) name.
        // On Windows and Linux, the way the Start menu or the application menu would start it.
        const ia = this.platform === 'darwin' ? undefined : await this.installedApp(app)
        const opened = this.platform === 'darwin' ? await openMac(app) : !!ia && (await this.openOther(app, ia))
        const by = this.platform === 'win32' ? (ia?.exe && !ia.id?.includes('!') ? ia.exe : app) : this.platform === 'linux' ? (ia?.id ?? app) : app
        const extra = this.platform === 'linux' && ia?.chromium ? ['--arg=--force-renderer-accessibility'] : []
        const r: Envelope = opened ? { ok: true } : await run(this.cli, ['launch', by, ...extra, '--activate', '--timeout', '25000'], { tries: 2 })
        if (!r.ok && r.error?.code !== 'TIMEOUT')
          return {
            result: textResult(L(`Não abriu o ${app}: ${failure(r)}`, `${app} didn't open: ${failure(r)}`), true)
          }
        // A slow app: the window may come after the launch gave up waiting.
        for (let i = 0; i < 10; i++) {
          const { list } = await this.windowsOf(await this.target(app, i > 0 || this.platform !== 'darwin'))
          if (list.length > 0) {
            // Chromium's screen on Windows fills in over a few seconds after it opens.
            if (this.platform === 'win32' && ia?.chromium && i > 0) await wait(4_000)
            return { result: await this.read(id, app) }
          }
          await wait(1_500)
        }
        return {
          result: textResult(L(`O ${app} abriu, mas a janela não apareceu. Tente app_ver daqui a pouco.`, `${app} opened, but its window didn't show. Try app_ver in a moment.`), true)
        }
      }
      case 'app_ver': {
        const area = String(args['area'] ?? '').trim()
        const page = Number(args['pagina'] ?? 1) || 1
        if (!area) return { result: await this.read(id, app, [], page) }
        const it = this.item(id, app, area)
        if ('error' in it) return { result: textResult(it.error, true) }
        return { result: await this.read(id, app, ['--root', it.ref], page) }
      }
      case 'app_menu':
        // Windows and Linux keep the menu bar inside the window: it's in the window's list.
        return { result: await this.read(id, app, this.platform === 'darwin' ? ['--surface', 'menubar'] : []) }
      case 'app_clicar': {
        const it = this.item(id, app, String(args['alvo'] ?? ''))
        if ('error' in it) return { result: textResult(it.error, true) }
        const label = it.name || `#${it.n}`
        // The first click after writing a new event (whatever the button is called) is what makes it.
        const last = this.written.get(id)
        const texto = last?.creates && norm(last.app) === norm(app) ? last.text.slice(0, 200) : ''
        if ((riskyClick(it.name) || texto) && !this.permitted(id, app, { alvo: it.name })) {
          const why = typeof args['motivo'] === 'string' ? args['motivo'].trim() : ''
          const what = texto ? L(`Confirmar "${texto}" no ${app}`, `Confirm "${texto}" in ${app}`) : L(`Clicar em "${label}" no ${app}`, `Click "${label}" in ${app}`)
          return {
            result: textResult(L(`Esse clique ("${label}" no ${app}) precisa de aprovação.`, `This click ("${label}" in ${app}) needs approval.`)),
            approval: {
              args: { app, alvo: it.name, ...(texto ? { texto } : {}), ...(this.lists.get(id)?.surface === 'menu' ? { onde: 'menu de contexto' } : this.lists.get(id)?.surface === 'menubar' ? { onde: 'barra de menus' } : {}) },
              why: why || what,
              detail: what
            }
          }
        }
        if (texto) this.written.delete(id)
        // A right click opens the element's own menu: read that menu next.
        if (args['botao_direito'] === true) {
          if (this.platform === 'win32')
            return { result: textResult(L(`No Windows, o clique direito mexeria no mouse de verdade. Use os botões e menus da janela (app_menu) ou selecione "${label}" com um clique e use o comando do menu.`, `On Windows, a right click would move the real mouse. Use the window's buttons and menus (app_menu), or select "${label}" with a click and use the menu's command.`), true) }
          const r = await run(this.cli, ['right-click', it.ref])
          if (!r.ok && r.error?.disposition?.retry !== 'safe' && !/UNRESPONSIVE|uncertain/i.test(`${r.error?.code} ${JSON.stringify(r.error?.disposition ?? {})}`))
            return { result: textResult(L(`O clique direito em "${label}" não foi: ${failure(r)}`, `The right click on "${label}" didn't go through: ${failure(r)}`), true) }
          await wait(500)
          const menu = await this.read(id, app, ['--surface', 'menu'])
          return { result: menu.isError ? await this.read(id, app) : menu, detail: `${label} · ${app}` }
        }
        if (it.actions && !it.actions.includes('Click') && it.actions.includes('RightClick'))
          return { result: textResult(L(`"${label}" só aceita clique direito: use app_clicar com botao_direito=true, ou clique na linha que o contém.`, `"${label}" only takes a right click: use app_clicar with botao_direito=true, or click the row that holds it.`), true) }
        const r = await run(this.cli, ['click', it.ref])
        if (!r.ok)
          return {
            result: textResult(L(`O clique em "${label}" não foi: ${failure(r)}`, `The click on "${label}" didn't go through: ${failure(r)}`), true)
          }
        return {
          result: await this.read(id, app),
          detail: `${label} · ${app}`
        }
      }
      case 'app_escrever': {
        const it = this.item(id, app, String(args['alvo'] ?? ''))
        if ('error' in it) return { result: textResult(it.error, true) }
        const text = String(args['texto'] ?? '')
        let r: Envelope
        if (args['teclando'] === true && this.platform === 'darwin') {
          await run(this.cli, ['focus', it.ref])
          r = await typeKeys(this.cli, app, text)
        } else if (args['teclando'] === true && this.platform === 'linux') {
          // Linux types into the field itself, with no keyboard of its own.
          r = await run(this.cli, ['type', it.ref, text])
          if (!r.ok) r = await run(this.cli, ['set-value', it.ref, text])
        } else {
          r = await run(this.cli, ['set-value', it.ref, text])
          // Windows: the value landed and the app shows it its own way (a field that formats).
          if (!r.ok && r.error?.details?.kind === 'post_action_verification') r = { ok: true }
          if (!r.ok && this.platform !== 'win32') r = await run(this.cli, ['type', it.ref, text])
        }
        if (r.ok) this.written.set(id, { app, text, creates: CREATES.test(norm(it.name)) })
        if (!r.ok)
          return {
            result: textResult(L(`Não consegui escrever em "${it.name || `#${it.n}`}": ${failure(r)}`, `Couldn't write into "${it.name || `#${it.n}`}": ${failure(r)}`), true)
          }
        return {
          result: await this.read(id, app),
          detail: `${it.name || `#${it.n}`} · ${app}`
        }
      }
      case 'app_tecla': {
        const combo = keyFor(String(args['tecla'] ?? '').trim(), this.platform)
        if (!combo)
          return {
            result: textResult(L('Faltou a tecla.', 'Missing the key.'), true)
          }
        if (riskyKey(combo) && !this.permitted(id, app, { tecla: combo })) {
          // Return right after writing confirms what was written: the request says what.
          const last = this.written.get(id)
          const texto = last && norm(last.app) === norm(app) && /^(return|enter)$/.test(combo) ? last.text.slice(0, 200) : ''
          const what = texto ? L(`Confirmar "${texto}" no ${app}`, `Confirm "${texto}" in ${app}`) : L(`Apertar ${combo} no ${app}`, `Press ${combo} in ${app}`)
          const why = typeof args['motivo'] === 'string' && args['motivo'].trim() ? args['motivo'].trim() : what
          return {
            result: textResult(L(`${what} precisa de aprovação.`, `${what} needs approval.`)),
            approval: { args: { app, tecla: combo, ...(texto ? { texto } : {}) }, why, detail: what }
          }
        }
        const who = await this.target(app)
        const only = await this.only(who)
        // Wayland lets no program bring a window forward or confirm which one has the keyboard:
        // a key goes only when the person has the app in front, and then to the window in front.
        if (this.wayland) {
          if (!(await this.windowsOf(who)).list.some((w) => w.is_focused))
            return {
              result: textResult(L(`A tecla não foi: no Wayland eu não consigo trazer o ${app} pra frente. Peça pra pessoa clicar na janela dele e tente de novo, ou faça pelos cliques.`, `The key didn't go: on Wayland I can't bring ${app} to the front. Ask the person to click its window and try again, or do it with clicks.`), true)
            }
          const r = await run(this.cli, ['press', combo])
          if (!r.ok) return { result: textResult(L(`A tecla não foi: ${failure(r)}`, `The key didn't go through: ${failure(r)}`), true) }
          return { result: await this.read(id, app), detail: `${combo} · ${app}` }
        }
        let r = await run(this.cli, ['press', combo, '--app', who, ...only])
        // Off a Mac a key goes to the window in front: bring the app's forward, once.
        if (!r.ok && this.platform !== 'darwin') {
          await run(this.cli, ['focus-window', '--app', who, ...only])
          r = await run(this.cli, ['press', combo, '--app', who, ...only])
        }
        if (!r.ok)
          return {
            result: textResult(L(`A tecla não foi: ${failure(r)}`, `The key didn't go through: ${failure(r)}`), true)
          }
        return {
          result: await this.read(id, app),
          detail: `${combo} · ${app}`
        }
      }
    }
    return {
      result: textResult(L(`Ferramenta desconhecida: ${name}`, `Unknown tool: ${name}`), true)
    }
  }

  // An approved click or key becomes a one-time permit: the agent comes back, sets the
  // window up again (the state may have changed while it waited: a note to select) and does
  // it itself; that one action then goes through without asking. Half an hour, once.
  approved(agent: Agent, args: Record<string, unknown>): { ok: boolean; text: string } {
    const grant = grantOf(agent, String(args['app'] ?? ''))
    if (!grant || grant.level !== 'read_write') return { ok: false, text: L('o app não está mais liberado pra esse agente.', 'the app is no longer given to this agent.') }
    const list = (this.permits.get(agent.id) ?? []).filter((p) => p.until > Date.now())
    list.push({ key: permitKey(grant.name, args), until: Date.now() + PERMIT_MS })
    this.permits.set(agent.id, list)
    return { ok: true, text: '' }
  }

  // Spends a permit for this action, if there is one.
  private permitted(agentId: string, app: string, args: Record<string, unknown>): boolean {
    const list = (this.permits.get(agentId) ?? []).filter((p) => p.until > Date.now())
    // Only the exact element that was approved: approving "Apagar" never lets "Apagar Tudo" through.
    const key = permitKey(app, args)
    const i = list.findIndex((p) => p.key === key)
    if (i < 0) return false
    list.splice(i, 1)
    this.permits.set(agentId, list)
    return true
  }
}
