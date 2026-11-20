// Searching the web and reading a page, as the app's own tools: for an agent on an endpoint (no harness,
// so no harness's web search), with "Web" on. The search is Exa's public MCP server, the one OpenCode
// searches with by default: no key, with a usage limit of Exa's. A page is read the way the wiki reads a
// link (wiki-extract.ts): through the guard against the inside of the network, its main content only,
// a PDF's text too.
import { L } from '../shared/lang'
import type { ToolDef } from './gateway'
import { extractLink, type Fetcher } from './wiki-extract'
import { safeFetch } from './safe-fetch'

export const EXA_MCP = 'https://mcp.exa.ai/mcp'
const MAX_RESULTS = 10
const MAX_SNIPPET = 700 // characters of each result's text
const MAX_PAGE = 40_000 // characters of a page handed to the model
const MAX_BODY = 512 * 1024

export const BUSCAR_NA_WEB: ToolDef = {
  name: 'buscar_na_web',
  get description() {
    return L(
      'Busca na web e devolve os resultados: título, endereço, data e um trecho de cada. Use pra fatos recentes, preços, documentação, notícias. Pra ler um resultado inteiro, use ler_pagina com o endereço.',
      'Searches the web and returns the results: title, address, date and an excerpt of each. Use it for recent facts, prices, documentation, news. To read a result in full, use ler_pagina with its address.'
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: {
        busca: { type: 'string', description: L('O que buscar, como você digitaria num buscador.', 'What to search for, as you would type it in a search engine.') },
        quantos: { type: 'number', description: L(`Quantos resultados (1 a ${MAX_RESULTS}; 6 se não disser).`, `How many results (1 to ${MAX_RESULTS}; 6 if not said).`) }
      },
      required: ['busca']
    }
  }
}

export const LER_PAGINA: ToolDef = {
  name: 'ler_pagina',
  get description() {
    return L(
      'Lê uma página da web (ou um PDF na web) e devolve o texto principal, sem menus nem anúncios. Só endereços públicos, com http:// ou https://.',
      'Reads a web page (or a PDF on the web) and returns its main text, without menus or ads. Public addresses only, with http:// or https://.'
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: { url: { type: 'string', description: L('O endereço da página.', "The page's address.") } },
      required: ['url']
    }
  }
}

export const WEB_TOOLS = [BUSCAR_NA_WEB, LER_PAGINA]
export const WEB_TOOL_NAMES = new Set(WEB_TOOLS.map((t) => t.name))

export interface WebResult {
  url: string
  title?: string
  published?: string
  text?: string
}

// Exa's answer is one text block of results separated by "---", each with Title:, URL:, Published:
// and its text (Text: or Highlights:).
export function parseExa(text: string): WebResult[] {
  return text.split(/\n\s*---\s*\n/).flatMap((block) => {
    const url = /^URL:\s*(.+)$/m.exec(block)?.[1]?.trim()
    if (!url) return []
    const title = /^Title:\s*(.+)$/m.exec(block)?.[1]?.trim()
    const published = /^Published(?: Date)?:\s*(.+)$/m.exec(block)?.[1]?.trim()
    const body = /^(?:Highlights|Text|Summary):\s*\n?([\s\S]*)$/m.exec(block)?.[1]?.trim()
    return [{ url, ...(title && title !== 'N/A' ? { title } : {}), ...(published && published !== 'N/A' ? { published: published.slice(0, 10) } : {}), ...(body ? { text: body } : {}) }]
  })
}

// An MCP tools/call answered as JSON, or as server-sent events with the JSON in a "data:" line.
function resultOf(body: string): { content?: { type?: string; text?: string }[]; isError?: boolean } | undefined {
  const parse = (s: string): { result?: { content?: { type?: string; text?: string }[]; isError?: boolean }; error?: { message?: string } } | undefined => {
    const t = s.trim()
    if (!t.startsWith('{')) return undefined
    try {
      return JSON.parse(t)
    } catch {
      return undefined
    }
  }
  const direct = parse(body)
  if (direct?.error) throw new Error(direct.error.message ?? 'Exa')
  if (direct?.result) return direct.result
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const msg = parse(line.slice(5))
    if (msg?.error) throw new Error(msg.error.message ?? 'Exa')
    if (msg?.result) return msg.result
  }
  return undefined
}

export async function searchWeb(query: string, count = 6, f: typeof fetch = fetch, key?: string): Promise<WebResult[]> {
  const url = new URL(EXA_MCP)
  if (key) url.searchParams.set('exaApiKey', key)
  const res = await f(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search_exa', arguments: { query, numResults: Math.min(MAX_RESULTS, Math.max(1, Math.round(count))) } } }),
    signal: AbortSignal.timeout(25_000)
  })
  if (res.status === 429) throw new Error(L('A busca está no limite de uso por agora. Tente de novo em alguns minutos.', 'Search is at its usage limit for now. Try again in a few minutes.'))
  if (!res.ok) throw new Error(L(`A busca respondeu ${res.status}.`, `The search answered ${res.status}.`))
  const body = (await res.text()).slice(0, MAX_BODY)
  const result = resultOf(body)
  const text = result?.content?.find((c) => c.text)?.text ?? ''
  if (result?.isError) throw new Error(text || L('A busca falhou.', 'The search failed.'))
  return parseExa(text)
}

// The results as the model reads them: numbered, with where each came from.
export function formatResults(query: string, results: WebResult[]): string {
  if (!results.length) return L(`Nenhum resultado para "${query}".`, `No results for "${query}".`)
  return results
    .map((r, i) => {
      const text = r.text ? r.text.replace(/\s+/g, ' ').trim() : ''
      const snippet = text.length > MAX_SNIPPET ? `${text.slice(0, MAX_SNIPPET)}…` : text
      return [`${i + 1}. ${r.title ?? r.url}`, r.url, r.published ? `${L('Publicado', 'Published')}: ${r.published}` : '', snippet].filter(Boolean).join('\n')
    })
    .join('\n\n')
}

export async function readPage(url: string, fetcher: Fetcher = safeFetch()): Promise<string> {
  const { title, text } = await extractLink(url.trim(), fetcher)
  const body = text.length > MAX_PAGE ? `${text.slice(0, MAX_PAGE)}\n\n[… ${L(`cortado: mais ${text.length - MAX_PAGE} caracteres`, `cut: ${text.length - MAX_PAGE} more characters`)}]` : text
  return `# ${title}\n${url.trim()}\n\n${body}`
}
