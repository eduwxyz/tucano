// The vault as the agent meets it: a section of its prompt (names and what each is for, never a
// value) and vault_http, the safest way to use an API key: the app makes the request, sends the
// secret only to the item's hosts, never follows a redirect elsewhere, and masks what comes back.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { L } from '../../shared/lang'
import type { VaultItem } from '../../shared/types'
import { textResult, type ToolDef } from '../gateway'
import { blockedAddress, safeFetch } from '../safe-fetch'
import { hasRefs, type VaultTurn } from './refs'

export const VAULT_HTTP = 'vault_http'
export const VAULT_CONNECTOR = 'vault' // the "connector" of vault_http's approvals
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const MAX_BODY = 1024 * 1024
const MAX_TEXT = 30_000
const TIMEOUT_MS = 60_000

export const vaultHttpTool = (): ToolDef => ({
  name: VAULT_HTTP,
  description: L(
    'Faz uma requisição HTTP(S) com segredos do cofre, sem você ver o valor: escreva {{vault:nome}} (ou {{vault:nome.campo}}) na url, nos headers ou no body, e o app põe o valor só na hora de enviar. Cada segredo só vai pros hosts dele; redirecionamentos voltam pra você sem ser seguidos. A resposta volta com os segredos mascarados como [vault:nome].',
    'Makes an HTTP(S) request with vault secrets, without you seeing the value: write {{vault:name}} (or {{vault:name.field}}) in the url, headers or body, and the app puts the value in only when sending. Each secret only goes to its own hosts; redirects come back to you without being followed. The response comes back with the secrets masked as [vault:name].'
  ),
  inputSchema: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: [...METHODS] },
      url: { type: 'string', description: L('Endereço completo, com https://.', 'Full address, with https://.') },
      headers: { type: 'object', additionalProperties: { type: 'string' }, description: L('Ex.: {"Authorization": "Bearer {{vault:github_token}}"}', 'E.g. {"Authorization": "Bearer {{vault:github_token}}"}') },
      body: { type: 'string', description: L('O corpo, como texto (JSON já serializado).', 'The body, as text (JSON already serialized).') }
    },
    required: ['method', 'url']
  }
})

const KIND_LABEL = (): Record<VaultItem['kind'], string> => ({
  api_key: 'API key',
  token: 'token',
  password: L('senha', 'password'),
  login: L('login (usuário e senha)', 'login (username and password)'),
  url: L('URL secreta', 'secret URL'),
  note: L('nota secreta: você não lê o texto, só envia', "secret note: you don't read the text, only send it")
})

// The prompt's part: what the agent may use and how. `where`: the tools that take a reference besides vault_http.
export function vaultSection(me: string, items: VaultItem[], where: { shell: boolean; browser: boolean; connectors: boolean }): string {
  const kinds = KIND_LABEL()
  const line = (i: VaultItem): string => {
    const fields = i.fields.length > 1 ? L(` · campos: ${i.fields.map((f) => `{{vault:${i.name}.${f}}}`).join(', ')}`, ` · fields: ${i.fields.map((f) => `{{vault:${i.name}.${f}}}`).join(', ')}`) : ''
    const reach = i.scope === 'http' ? L(` · só em vault_http, pra ${i.hosts.join(', ')}`, ` · vault_http only, to ${i.hosts.join(', ')}`) : i.hosts.length ? L(` · em vault_http só pra ${i.hosts.join(', ')}`, ` · in vault_http only to ${i.hosts.join(', ')}`) : ''
    const ask = i.askEachUse ? L(' · cada uso pede aprovação', ' · each use asks for approval') : ''
    const missing = i.missing ? L(' · SEM VALOR agora: não funciona até alguém salvar de novo', ' · NO VALUE right now: it won\'t work until someone saves it again') : ''
    return `- {{vault:${i.name}}} (${kinds[i.kind]})${i.description ? `: ${i.description.replace(/\s+/g, ' ')}` : ''}${fields}${reach}${ask}${missing}`
  }
  const also = [where.shell && L('comandos (bash) e arquivos que você escreve', 'commands (bash) and files you write'), where.browser && L('o que você digita no navegador', 'what you type in the browser'), where.connectors && L('argumentos de conectores', "connectors' arguments")].filter(Boolean)
  return [
    L('## O cofre', '## The vault'),
    L(
      `${me} guardou segredos pra você usar sem ver: escreva a referência e o app põe o valor só na hora de rodar. Você nunca recebe o valor; o que volta vem mascarado como [vault:nome]. Não peça o valor a ninguém, não tente mostrá-lo nem tirá-lo daqui (echo, base64, mandar pra outro lugar). Nem ${me} vê o valor depois de salvo: o cofre só deixa trocar. Se alguém precisar da chave em outro lugar, ela vem de onde foi emitida (o painel do serviço), não do cofre nem de você.`,
      `${me} saved secrets for you to use without seeing them: write the reference and the app puts the value in only when it runs. You never get the value; what comes back is masked as [vault:name]. Don't ask anyone for the value, and don't try to show it or get it out (echo, base64, sending it elsewhere). Not even ${me} sees the value once saved: the vault only lets it be replaced. If someone needs the key elsewhere, it comes from where it was issued (the service's dashboard), not from the vault or from you.`
    ),
    L(
      `Use em vault_http (o jeito mais seguro pra APIs)${also.length ? `, e também em ${also.join(', ')}, pros segredos liberados pra isso` : ''}. Num comando, a referência vira uma variável de ambiente; não use dentro de um heredoc com aspas (<<'EOF').`,
      `Use them in vault_http (the safest way for APIs)${also.length ? `, and also in ${also.join(', ')}, for the secrets allowed there` : ''}. In a command, the reference becomes an environment variable; don't use it inside a quoted heredoc (<<'EOF').`
    ),
    ...items.map(line)
  ].join('\n')
}

// A value goes in fitted to where it stands, so quotes, line breaks or "&" in a secret (a note, a
// password) never break the request:
// - a JSON body: the references are replaced inside the parsed JSON and it's written again (escaped);
// - a form body: URL-encoded;
// - anything else: as it is.
export function expandBody(turn: VaultTurn, body: string, type: string): string {
  if (!hasRefs(body)) return body
  if (/x-www-form-urlencoded/i.test(type)) return turn.expand(body, VAULT_HTTP, encodeURIComponent)
  if (!type || /json/i.test(type)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = undefined
    }
    if (parsed !== undefined) return JSON.stringify(turn.expandDeep(parsed, VAULT_HTTP))
  }
  return turn.expand(body, VAULT_HTTP)
}

// A URL that starts with a reference is a secret URL, put in whole; a reference inside one (a path
// part, a query parameter) goes in URL-encoded.
export function expandUrl(turn: VaultTurn, raw: string): string {
  const lead = /^\s*\{\{\s*vault:[^}]*\}\}/i.exec(raw)?.[0] ?? ''
  return turn.expand(lead, VAULT_HTTP) + turn.expand(raw.slice(lead.length), VAULT_HTTP, encodeURIComponent)
}

// Makes the request. The call was checked (refs, hosts, vault open) by the caller; the inside of the
// network is out of reach unless every secret it carries names that exact host.
export async function vaultHttp(turn: VaultTurn, args: Record<string, unknown>, opts: { signal?: AbortSignal; fetch?: ReturnType<typeof safeFetch> } = {}): Promise<CallToolResult> {
  const method = String(args['method'] ?? 'GET').toUpperCase()
  if (!(METHODS as readonly string[]).includes(method)) return textResult(L(`Método inválido. Use: ${METHODS.join(', ')}.`, `Invalid method. Use: ${METHODS.join(', ')}.`), true)
  const rawUrl = typeof args['url'] === 'string' ? args['url'].trim() : ''
  if (!rawUrl) return textResult(L('Faltou a url.', 'Missing the url.'), true)
  const headersIn = args['headers'] && typeof args['headers'] === 'object' && !Array.isArray(args['headers']) ? (args['headers'] as Record<string, unknown>) : {}
  const body = typeof args['body'] === 'string' ? args['body'] : undefined
  if (body && Buffer.byteLength(body) > MAX_BODY) return textResult(L('Corpo grande demais (até 1 MB).', 'Body too big (up to 1 MB).'), true)
  const checked = turn.check({ url: rawUrl, headers: headersIn, body }, 'http', VAULT_HTTP)
  if (checked.error) return textResult(checked.error, true)
  if (!checked.items.length) return textResult(L('vault_http é pra chamadas com um segredo do cofre ({{vault:nome}}). Pra ler uma página, use as ferramentas da web.', 'vault_http is for calls with a vault secret ({{vault:name}}). To read a page, use the web tools.'), true)
  const url = expandUrl(turn, rawUrl)
  let at: URL
  try {
    at = new URL(url)
  } catch {
    return textResult(L('Endereço inválido.', 'Invalid address.'), true)
  }
  if (at.protocol !== 'https:' && at.protocol !== 'http:') return textResult(L('O endereço precisa começar com https:// ou http://.', 'The address must start with https:// or http://.'), true)
  const hostError = turn.hostCheck(checked.items, url, VAULT_HTTP)
  if (hostError) return textResult(hostError, true)
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(headersIn)) if (typeof v === 'string' && /^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(k)) headers[k] = turn.expand(v, VAULT_HTTP)
  const sending = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
  const sent = body === undefined ? undefined : expandBody(turn, body, sending)
  if (sent !== undefined && !sending) headers['content-type'] = 'application/json'
  // The inside (localhost, the LAN): only for secrets that name this exact host (a home server, say).
  const host = at.hostname.toLowerCase()
  const inside = checked.items.every((i) => i.hosts.some((h) => h.split(':')[0] === host))
  const fetcher = opts.fetch ?? safeFetch({ blocked: inside ? () => false : blockedAddress })
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)
  let res: Response
  try {
    res = await fetcher(url, { method, headers, ...(sent !== undefined ? { body: sent } : {}), signal, redirect: 'manual' })
  } catch (e) {
    return textResult(turn.scrub(L(`A requisição falhou: ${e instanceof Error ? e.message : String(e)}`, `The request failed: ${e instanceof Error ? e.message : String(e)}`)), true)
  }
  const type = res.headers.get('content-type') ?? ''
  const head = [`HTTP ${res.status}`, type && `content-type: ${type}`, res.headers.get('location') && `location: ${res.headers.get('location')} ${L('(não seguido)', '(not followed)')}`].filter(Boolean).join('\n')
  let text = ''
  if (method !== 'HEAD') {
    const buf = Buffer.from(await res.arrayBuffer())
    const binary = buf.length > 0 && !/json|text|xml|javascript|x-www-form-urlencoded|graphql/i.test(type) && buf.subarray(0, 1024).includes(0)
    text = binary ? L(`[${buf.length} bytes binários]`, `[${buf.length} binary bytes]`) : buf.toString('utf8')
    if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n${L('[… resposta cortada]', '[… response cut]')}`
  }
  return textResult(turn.scrub(`${head}\n\n${text}`), res.status >= 400)
}
