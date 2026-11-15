// The guides (/guias/, /docs/): each one a folder with pt.md and en.md, front matter on top and
// Markdown below. build.mjs turns them into pages; this file reads and checks them, with no
// dependencies, so the site still builds with plain Node. See guias/README.md for how to write one.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ---------- front matter: `key: value` lines and one list, `faq:`, of `- pergunta:` / `resposta:` ----------
const unquote = (v) => {
  v = v.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1)
  return v
}

export function frontMatter(src, file) {
  const m = src.replace(/\r\n?/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) throw new Error(`${file}: no front matter (it starts and ends with a line of ---)`)
  const data = {}
  let list = null
  let item = null
  for (const [i, raw] of m[1].split('\n').entries()) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const where = `${file}, line ${i + 2}`
    const top = line.match(/^([a-z_]+):\s*(.*)$/)
    if (top) {
      list = null
      if (top[2] === '') { list = data[top[1]] = [] } else data[top[1]] = unquote(top[2])
      continue
    }
    const entry = line.match(/^\s+-\s+([a-z_]+):\s*(.+)$/)
    if (entry && list) { list.push((item = { [entry[1]]: unquote(entry[2]) })); continue }
    const more = line.match(/^\s+([a-z_]+):\s*(.+)$/)
    if (more && item && list) { item[more[1]] = unquote(more[2]); continue }
    throw new Error(`${where}: can't read "${line.trim()}"`)
  }
  return { data, body: m[2] }
}

// ---------- Markdown: the part guides need ----------
// ## and ### headings, paragraphs, - lists, 1. lists, ``` code blocks, | tables |, > notes,
// and inside a line **bold**, *italic*, `code` and [links](/address/).
// Links go only to /, #, https://, http:// and mailto: (no javascript: or data:), and bold/italic
// are applied before the links go back in, so a * in an address never lands inside the attribute.
const SAFE_HREF = /^(\/(?![/\\])|#|https?:\/\/|mailto:)/i // not //host or /\host: other sites
const emphasis = (s) => s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
export function inline(s, file = 'markdown') {
  const codes = []
  const links = []
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
  s = esc(s)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => {
    if (!SAFE_HREF.test(href)) throw new Error(`${file}: link "${href}": only addresses starting with /, #, https://, http:// or mailto:`)
    return `\u0001${links.push(`<a href="${href}">${emphasis(t)}</a>`) - 1}\u0001`
  })
  s = emphasis(s)
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => links[i])
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`)
}

export const slugify = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export function markdown(md, file = 'markdown') {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out = []
  const headings = [] // { level, text, id }
  const ids = new Set()
  let i = 0
  const isBlockStart = (l) => /^(#{1,6} |```|[-*] |\d+\. |\||> )/.test(l)
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const code = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++])
      if (i >= lines.length) throw new Error(`${file}: a \`\`\` block that never closes`)
      i++
      out.push(`<pre><code${lang ? ` class="lang-${esc(lang)}"` : ''}>${esc(code.join('\n'))}</code></pre>`)
      continue
    }
    const h = line.match(/^(#{1,6}) (.+)$/)
    if (h) {
      const level = h[1].length
      if (level === 1) throw new Error(`${file}: no # headings in the text: the page's title is the "titulo" up top. Use ## and ###.`)
      if (level > 3) throw new Error(`${file}: use only ## and ### headings`)
      let id = slugify(h[2])
      for (let n = 2; ids.has(id); n++) id = `${slugify(h[2])}-${n}`
      ids.add(id)
      headings.push({ level, text: h[2], id })
      out.push(`<h${level} id="${id}">${inline(h[2], file)}</h${level}>`)
      i++
      continue
    }
    const list = line.match(/^([-*]|\d+\.) /)
    if (list) {
      const ordered = /\d/.test(list[1])
      const items = []
      while (i < lines.length && (/^([-*]|\d+\.) /.test(lines[i]) || (/^ {2,}\S/.test(lines[i]) && items.length))) {
        if (/^ {2,}\S/.test(lines[i])) items[items.length - 1] += ' ' + lines[i].trim()
        else items.push(lines[i].replace(/^([-*]|\d+\.) /, ''))
        i++
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t, file)}</li>`).join('')}</${tag}>`)
      continue
    }
    if (line.startsWith('|')) {
      const rows = []
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++])
      const cells = (r) => r.replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim())
      if (rows.length < 2 || !/^\|?\s*:?-{3,}/.test(rows[1])) throw new Error(`${file}: a table needs a header row and a |---| row under it`)
      const head = cells(rows[0]).map((c) => `<th>${inline(c, file)}</th>`).join('')
      const body = rows.slice(2).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c, file)}</td>`).join('')}</tr>`).join('')
      out.push(`<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`)
      continue
    }
    if (line.startsWith('> ')) {
      const note = []
      while (i < lines.length && lines[i].startsWith('>')) note.push(lines[i++].replace(/^>\s?/, ''))
      out.push(`<aside class="note"><p>${inline(note.join(' '), file)}</p></aside>`)
      continue
    }
    const para = []
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++].trim())
    if (!para.length) throw new Error(`${file}: can't read "${line}"`)
    out.push(`<p>${inline(para.join(' '), file)}</p>`)
  }
  return { html: out.join('\n'), headings }
}

// Plain text of a bit of Markdown (for structured data and llms.txt).
export const plain = (md) => md.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim()

// The first paragraph under a ## heading, as plain text (a HowTo step's text).
function sectionText(body, heading) {
  const lines = body.split('\n')
  const at = lines.findIndex((l) => l === `## ${heading}`)
  const rest = []
  for (const l of lines.slice(at + 1)) { if (/^#{2,3} /.test(l)) break; rest.push(l) }
  const para = rest.join('\n').split(/\n\s*\n/).map((b) => b.trim()).find((b) => b && !b.startsWith('```'))
  return para ? plain(para.replace(/^([-*]|\d+\.) /gm, '')) : ''
}

// ---------- one guide, in one language, read and checked ----------
const REQUIRED = ['slug', 'titulo', 'descricao', 'atualizado', 'grupo']

export function readGuide(src, file) {
  const { data, body } = frontMatter(src, file)
  for (const k of REQUIRED) if (!data[k]) throw new Error(`${file}: "${k}" is missing up top`)
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(data.slug)) throw new Error(`${file}: slug "${data.slug}": only lowercase letters, numbers and hyphens`)
  if (!data.titulo.trim().endsWith('?')) throw new Error(`${file}: the "titulo" is the question the page answers, ending in "?"`)
  if (data.descricao.length > 170) throw new Error(`${file}: "descricao" has ${data.descricao.length} characters; search engines show about 160`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.atualizado)) throw new Error(`${file}: "atualizado" as 2026-11-15`)
  const faq = data.faq || []
  if (!Array.isArray(faq)) throw new Error(`${file}: "faq" is a list of - pergunta: / resposta:`)
  for (const f of faq) if (!f.pergunta || !f.resposta) throw new Error(`${file}: every faq item has a "pergunta" and a "resposta"`)
  if (data.ordem !== undefined && !/^\d+$/.test(data.ordem)) throw new Error(`${file}: "ordem" is a whole number, like 2`)
  const howto = data.howto === 'sim' || data.howto === 'yes' || data.howto === 'true'
  const { html, headings } = markdown(body, file)
  const firstPara = body.split(/\n\s*\n/).map((b) => b.trim()).find((b) => b && !/^(#|```|[-*] |\d+\. |\||>)/.test(b))
  if (!firstPara) throw new Error(`${file}: start the text with a paragraph that answers the question`)
  // HowTo: the steps are the ## headings that start with a number ("## 1. Download…").
  const steps = howto ? headings.filter((h) => h.level === 2 && /^\d+\.\s/.test(h.text)) : []
  if (howto && steps.length < 2) throw new Error(`${file}: "howto: sim" needs at least two steps as ## 1. …, ## 2. …`)
  return {
    slug: data.slug,
    title: data.titulo.trim(),
    desc: data.descricao.trim(),
    updated: data.atualizado,
    published: data.publicado || data.atualizado,
    group: data.grupo.trim(),
    order: data.ordem ? Number(data.ordem) : 100,
    faq: faq.map((f) => ({ q: f.pergunta, a: f.resposta })),
    howto,
    steps: steps.map((h) => ({ name: plain(h.text.replace(/^\d+\.\s*/, '')), id: h.id, text: sectionText(body, h.text) })),
    answer: plain(firstPara),
    html,
    headings,
    body,
  }
}
