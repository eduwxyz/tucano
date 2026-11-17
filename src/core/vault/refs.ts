// How an agent uses a vault item without seeing it: it writes {{vault:name}} (or {{vault:name.field}})
// in a tool's arguments, and the app puts the value in only where the call runs:
//  - in a command, as an environment variable of that process ("${TUCANO_VAULT_1}"), never in its text;
//  - in vault_http's URL, headers and body, sent only to the item's hosts;
//  - in a file written, text typed in the browser, a connector's arguments (items allowed "anywhere").
// Whatever comes back (output, errors, pages) has every value the agent may use masked as
// [vault:name] before the model reads it. Steps, approvals and transcripts keep the reference.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { L } from '../../shared/lang'
import type { Agent, VaultItem } from '../../shared/types'
import { hostAllowed, type Vault } from './index'

export const REF_RE = /\{\{\s*vault:([a-z0-9][a-z0-9_-]{0,63})(?:\.([a-z_]{1,32}))?\s*\}\}/gi
const REF_AT = new RegExp(REF_RE.source, 'iy') // a reference starting exactly here
const MIN_MASK = 6 // shorter values are used, but masking them would hide ordinary text

export type VaultUseKind = 'http' | 'shell' | 'file' | 'browser' | 'connector'

export interface Ref {
  token: string // as written
  name: string
  field?: string
}

export function refsIn(value: unknown, out: Ref[] = []): Ref[] {
  if (typeof value === 'string') {
    for (const m of value.matchAll(REF_RE)) if (!out.some((r) => r.token === m[0])) out.push({ token: m[0], name: m[1]!.toLowerCase(), ...(m[2] ? { field: m[2].toLowerCase() } : {}) })
  } else if (Array.isArray(value)) for (const v of value) refsIn(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) refsIn(v, out)
  return out
}

export const hasRefs = (value: unknown): boolean => refsIn(value).length > 0

// A command with each reference turned into an environment variable, quoted for where it stands:
// outside quotes "${V}", inside double quotes ${V}, inside single quotes '"${V}"' (closing and
// reopening them). cmd.exe: %V%. A quoted heredoc (<<'EOF') doesn't expand variables: the tool says so.
export function shellWithEnv(command: string, names: Map<string, string>, kind: 'bash' | 'cmd' = 'bash'): string {
  if (kind === 'cmd') return command.replace(REF_RE, (t) => (names.has(t) ? `%${names.get(t)}%` : t))
  let out = ''
  let quote: '' | "'" | '"' = ''
  for (let i = 0; i < command.length; ) {
    const ch = command[i]!
    if (ch === '{' && command[i + 1] === '{') {
      REF_AT.lastIndex = i
      const hit = REF_AT.exec(command)
      if (hit && names.has(hit[0])) {
        const v = names.get(hit[0])!
        out += quote === '"' ? `\${${v}}` : quote === "'" ? `'"\${${v}}"'` : `"\${${v}}"`
        i += hit[0].length
        continue
      }
    }
    if (ch === '\\' && quote !== "'") {
      out += command.slice(i, i + 2)
      i += 2
      continue
    }
    if (ch === "'" && quote !== '"') quote = quote === "'" ? '' : "'"
    else if (ch === '"' && quote !== "'") quote = quote === '"' ? '' : '"'
    out += ch
    i++
  }
  return out
}

// The forms a value can come back in: as is, in JSON, base64, base64url, URL-encoded, hex.
export function variants(value: string): string[] {
  if (value.length < MIN_MASK) return []
  const b = Buffer.from(value, 'utf8')
  const forms = new Set([value, JSON.stringify(value).slice(1, -1), b.toString('base64'), b.toString('base64').replace(/=+$/, ''), b.toString('base64url'), encodeURIComponent(value), b.toString('hex'), b.toString('hex').toUpperCase()])
  // Each line of a multi-line value (a key file) on its own, too.
  for (const line of value.split(/\r?\n/)) if (line.trim().length >= 16) forms.add(line.trim())
  return [...forms].filter((f) => f.length >= MIN_MASK).sort((x, y) => y.length - x.length)
}

export function scrubText(text: string, masks: { forms: string[]; label: string }[]): string {
  let out = text
  for (const m of masks) for (const f of m.forms) if (out.includes(f)) out = out.split(f).join(m.label)
  return out
}

// One reply's (or one approved call's) use of the vault, by one agent.
export class VaultTurn {
  private values = new Map<string, string>() // token → value, for the refs this turn resolved
  private masks: { forms: string[]; label: string }[] | undefined
  private used = new Set<string>()

  constructor(
    private vault: Vault,
    private agent: Pick<Agent, 'id' | 'kind' | 'archived'>,
    private conversationId?: string
  ) {}

  items(): VaultItem[] {
    return this.vault.usable(this.agent)
  }

  // Checks every reference in a call before anything runs: it exists for this agent, the vault is
  // open, the item may go where this call sends it. The error is the text for the agent; `ask`: an
  // item asks for approval on each use; `items`: the ones this call uses.
  check(args: unknown, use: VaultUseKind, tool: string, url?: string): { error?: string; ask: boolean; items: VaultItem[] } {
    const r = this.checkRefs(args, use, tool, url)
    // A refusal stops the whole call: nothing of it went anywhere, and the agent is told so in so many words.
    return r.error ? { ...r, error: `${r.error} ${L('Nada foi enviado nem executado nesta chamada.', 'Nothing in this call was sent or run.')}` } : r
  }

  private checkRefs(args: unknown, use: VaultUseKind, tool: string, url?: string): { error?: string; ask: boolean; items: VaultItem[] } {
    const refs = refsIn(args)
    if (!refs.length) return { ask: false, items: [] }
    const items: VaultItem[] = []
    for (const r of refs) {
      const item = this.vault.find(this.agent, r.name)
      if (!item) return { error: L(`Não há nada chamado "${r.name}" no cofre pra você. Os seus: ${this.names()}.`, `There's nothing called "${r.name}" in the vault for you. Yours: ${this.names()}.`), ask: false, items }
      if (item.missing) return { error: L(`"${r.name}" está sem valor agora: o cofre recomeçou e o valor precisa ser digitado de novo em Configurações › Cofre. Avise quem cuida do cofre.`, `"${r.name}" has no value right now: the vault started over and the value must be typed again in Settings › Vault. Tell whoever looks after the vault.`), ask: false, items }
      if (r.field && !item.fields.includes(r.field)) return { error: L(`"${r.name}" não tem o campo "${r.field}". Os campos: ${item.fields.join(', ')}.`, `"${r.name}" has no field "${r.field}". Its fields: ${item.fields.join(', ')}.`), ask: false, items }
      if (item.scope === 'http' && use !== 'http') {
        this.vault.record({ itemId: item.id, agentId: this.agent.id, conversationId: this.conversationId, tool, outcome: 'refused' })
        return {
          error: L(
            `"${r.name}" só pode ser usado com vault_http, pra ${item.hosts.join(', ')}. Faça a chamada com vault_http.`,
            `"${r.name}" can only be used with vault_http, to ${item.hosts.join(', ')}. Make the call with vault_http.`
          ),
          ask: false,
          items
        }
      }
      if (!items.some((i) => i.id === item.id)) items.push(item)
    }
    if (use === 'http' && url !== undefined) {
      const error = this.hostRefusal(items, url, tool)
      if (error) return { error, ask: false, items }
    }
    if (!this.vault.isOpen()) return { error: this.vault.closedMessage(), ask: false, items }
    return { ask: items.some((i) => i.askEachUse), items }
  }

  // Each item with hosts goes only to one of them (an item without hosts is "anywhere").
  hostCheck(items: VaultItem[], url: string, tool: string): string | undefined {
    const error = this.hostRefusal(items, url, tool)
    return error && `${error} ${L('Nada foi enviado nem executado nesta chamada.', 'Nothing in this call was sent or run.')}`
  }

  private hostRefusal(items: VaultItem[], url: string, tool: string): string | undefined {
    let at: URL | undefined
    try {
      at = new URL(url)
    } catch {
      at = undefined
    }
    for (const item of items) {
      if (!item.hosts.length) continue
      if (at && hostAllowed(at, item.hosts)) continue
      this.vault.record({ itemId: item.id, agentId: this.agent.id, conversationId: this.conversationId, tool, outcome: 'refused' })
      return L(`"${item.name}" só pode ir pra ${item.hosts.join(', ')}; esse endereço não é um deles.`, `"${item.name}" can only go to ${item.hosts.join(', ')}; that address isn't one of them.`)
    }
    return undefined
  }

  private names(): string {
    const n = this.items().map((i) => i.name)
    return n.length ? n.join(', ') : L('nenhum', 'none')
  }

  // The value behind a reference (already checked), opened now; each item counts once as used per turn.
  private value(r: Ref, tool: string): string {
    const known = this.values.get(r.token)
    if (known !== undefined) return known
    const item = this.vault.find(this.agent, r.name)
    if (!item) throw new Error(L(`Não há nada chamado "${r.name}" no cofre pra você.`, `There's nothing called "${r.name}" in the vault for you.`))
    const values = this.vault.reveal(item.id)
    const v = values[r.field ?? item.fields[0]!] ?? ''
    this.values.set(r.token, v)
    this.masks = undefined
    if (!this.used.has(item.id)) {
      this.used.add(item.id)
      this.vault.record({ itemId: item.id, agentId: this.agent.id, conversationId: this.conversationId, tool, outcome: 'used' })
    }
    return v
  }

  // Text with each reference replaced by its value; `encode` fits it to where it goes (a URL, a form).
  expand(text: string, tool: string, encode: (v: string) => string = (v) => v): string {
    return text.replace(REF_RE, (t) => {
      const [r] = refsIn(t)
      return r ? encode(this.value(r, tool)) : t
    })
  }

  expandDeep<T>(value: T, tool: string): T {
    if (typeof value === 'string') return this.expand(value, tool) as T
    if (Array.isArray(value)) return value.map((v) => this.expandDeep(v, tool)) as T
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.expandDeep(v, tool)])) as T
    return value
  }

  // A command whose references are environment variables, and those variables' values.
  shell(command: string, tool: string, kind: 'bash' | 'cmd' = 'bash'): { command: string; env: Record<string, string> } {
    const refs = refsIn(command)
    if (!refs.length) return { command, env: {} }
    const names = new Map<string, string>()
    const env: Record<string, string> = {}
    refs.forEach((r, i) => {
      const v = `TUCANO_VAULT_${i + 1}`
      names.set(r.token, v)
      env[v] = this.value(r, tool)
    })
    return { command: shellWithEnv(command, names, kind), env }
  }

  // Every value this agent may use, masked: what it resolved, and what it didn't but could meet
  // (a file it wrote before, a page that shows it).
  scrub(text: string): string {
    if (!text) return text
    if (!this.masks) {
      const masks: { forms: string[]; label: string }[] = []
      if (this.vault.isOpen())
        for (const item of this.items()) {
          let values: Record<string, string>
          try {
            values = this.vault.reveal(item.id)
          } catch {
            continue
          }
          for (const [field, v] of Object.entries(values)) masks.push({ forms: variants(v), label: `[vault:${item.name}${field === item.fields[0] ? '' : `.${field}`}]` })
        }
      for (const [token, v] of this.values) if (!masks.some((m) => m.forms.includes(v))) masks.push({ forms: variants(v), label: token.replace(/^\{\{\s*/, '[').replace(/\s*\}\}$/, ']') })
      this.masks = masks.filter((m) => m.forms.length).sort((a, b) => (b.forms[0]?.length ?? 0) - (a.forms[0]?.length ?? 0))
    }
    return scrubText(text, this.masks)
  }

  scrubResult(r: CallToolResult): CallToolResult {
    if (!this.values.size && !this.items().length) return r
    return { ...r, content: r.content.map((c) => (c.type === 'text' ? { ...c, text: this.scrub(c.text) } : c)) }
  }

  close(): void {
    this.values.clear()
    this.masks = undefined
  }
}
