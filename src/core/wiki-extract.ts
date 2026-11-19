// What a file or a link says, as text the wiki's curator can read: PDF (unpdf, no worker),
// Word (mammoth), spreadsheets (exceljs, each sheet a table), CSV, plain text and Markdown;
// a web page through Readability, so only its main content comes along. All in the core,
// nothing leaves the computer except the fetch of the link itself.
import { extname } from 'node:path'
import { L, locale } from '../shared/lang'
import { MAX_WIKI_FILE } from '../shared/rpc-shapes'
import { safeFetch } from './safe-fetch'

export const MAX_FILE = MAX_WIKI_FILE
export const MAX_TEXT = 400_000 // characters kept from one source
const TEXT = new Set(['.txt', '.md', '.markdown', '.json', '.log', '.yml', '.yaml'])
export const ACCEPTS = ['.pdf', '.docx', '.xlsx', '.csv', ...TEXT]

const clip = (s: string): string => {
  const t = s.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n\n${L('[o resto do texto foi cortado]', '[the rest of the text was cut]')}` : t
}

// A grid as a Markdown table; a long one keeps its first rows.
function table(rows: string[][], max = 400): string {
  const width = Math.max(0, ...rows.map((r) => r.length))
  if (!width) return ''
  const cell = (v: string): string => v.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()
  const pad = (r: string[]): string[] => Array.from({ length: width }, (_, k) => cell(r[k] ?? ''))
  const [head, ...body] = rows
  const lines = [`| ${pad(head!).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`, ...body.slice(0, max).map((r) => `| ${pad(r).join(' | ')} |`)]
  if (body.length > max) lines.push(L(`\n(${body.length - max} linhas a mais não entraram)`, `\n(${body.length - max} more rows left out)`))
  return lines.join('\n')
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  const sep = (text.split('\n')[0]!.match(/;/g)?.length ?? 0) > (text.split('\n')[0]!.match(/,/g)?.length ?? 0) ? ';' : ','
  let row: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cur += '"'), i++
      else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) row.push(cur), (cur = '')
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cur), rows.push(row), (row = []), (cur = '')
    } else cur += ch
  }
  if (cur || row.length) row.push(cur), rows.push(row)
  return rows.filter((r) => r.some((c) => c.trim()))
}

export async function extractFile(name: string, data: Buffer): Promise<string> {
  if (data.length > MAX_FILE) throw new Error(L(`O arquivo passa de ${MAX_FILE / 1024 / 1024} MB.`, `The file is over ${MAX_FILE / 1024 / 1024} MB.`))
  const ext = extname(name).toLowerCase()
  if (ext === '.pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(data))
    const { text } = await extractText(pdf, { mergePages: false })
    const pages = (Array.isArray(text) ? text : [text]).map((t, k) => `${L('Página', 'Page')} ${k + 1}\n\n${t}`)
    const out = clip(pages.join('\n\n'))
    if (out.replace(/(Página|Page) \d+/g, '').trim().length < 20) throw new Error(L('Esse PDF não tem texto (deve ser uma imagem escaneada).', 'This PDF has no text (it must be a scanned image).'))
    return out
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth')
    const { value } = await mammoth.extractRawText({ buffer: data })
    return clip(value)
  }
  if (ext === '.xlsx') {
    const { default: ExcelJS } = await import('exceljs')
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(data as unknown as ArrayBuffer)
    const parts: string[] = []
    book.eachSheet((sheet) => {
      const rows: string[][] = []
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const values = (row.values as unknown[]).slice(1)
        rows.push(values.map((v) => (v == null ? '' : typeof v === 'object' && v && 'text' in v ? String((v as { text: unknown }).text) : typeof v === 'object' && v && 'result' in v ? String((v as { result: unknown }).result) : v instanceof Date ? v.toLocaleDateString(locale()) : String(v))))
      })
      if (rows.length) parts.push(`## ${sheet.name}\n\n${table(rows)}`)
    })
    return clip(parts.join('\n\n'))
  }
  if (ext === '.csv') return clip(table(parseCsv(data.toString('utf8'))))
  if (TEXT.has(ext) || !ext) return clip(data.toString('utf8'))
  throw new Error(L(`Ainda não leio arquivos ${ext}. Dá pra usar PDF, Word, planilha (.xlsx, .csv) ou texto.`, `I can't read ${ext} files yet. PDF, Word, spreadsheets (.xlsx, .csv) or text work.`))
}

export type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>

// A web page's main content, and its title. Fetched through the guard against the inside (see
// safe-fetch) unless the caller passes the plain fetch: the desktop's own person, on their computer.
export async function extractLink(url: string, fetcher: Fetcher = safeFetch()): Promise<{ title: string; text: string }> {
  if (!/^https?:\/\//i.test(url)) throw new Error(L('O link precisa começar com http:// ou https://.', 'The link must start with http:// or https://.'))
  const res = await fetcher(url, { headers: { 'user-agent': 'Mozilla/5.0 (Tucano wiki)', accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8' }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(L(`A página respondeu ${res.status}.`, `The page answered ${res.status}.`))
  const type = res.headers.get('content-type') ?? ''
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_FILE) throw new Error(L('A página passa de 20 MB.', 'The page is over 20 MB.'))
  const last = new URL(res.url || url).pathname.split('/').pop() || 'arquivo'
  if (type.includes('pdf')) return { title: decodeURIComponent(last), text: await extractFile(`${last}.pdf`, buf) }
  if (!type.includes('html')) return { title: decodeURIComponent(last), text: clip(buf.toString('utf8')) }
  const { parseHTML } = await import('linkedom')
  const { Readability } = await import('@mozilla/readability')
  const { document } = parseHTML(buf.toString('utf8'))
  const article = new Readability(document as unknown as Document).parse()
  const title = (article?.title || document.querySelector('title')?.textContent || new URL(url).hostname).trim()
  // Paragraph by paragraph, so the curator sees the shape of the text.
  const html = article?.content ?? document.body?.innerHTML ?? ''
  const { document: doc } = parseHTML(`<!doctype html><html><body>${html}</body></html>`)
  const blocks = [...doc.querySelectorAll('h1,h2,h3,h4,p,li,pre,blockquote,td')].map((e) => {
    const t = (e.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!t) return ''
    if (/^H\d$/.test(e.tagName)) return `${'#'.repeat(Math.min(4, Number(e.tagName[1]) + 1))} ${t}`
    if (e.tagName === 'LI') return `- ${t}`
    return t
  })
  const text = clip(blocks.filter(Boolean).join('\n\n') || (article?.textContent ?? ''))
  if (text.length < 40) throw new Error(L('Não achei texto nessa página (pode precisar de login).', "I found no text on that page (it may need a login)."))
  return { title, text }
}
