import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import type { Settings } from '../src/shared/types'
import { Wiki } from '../src/core/wiki'
import { WikiCurator } from '../src/core/wiki-curator'
import { extractFile, extractLink, parseCsv } from '../src/core/wiki-extract'

// The smallest PDF with one line of text (pdf.js rebuilds the missing cross-reference table).
const pdf = (line: string): Buffer => {
  const stream = `BT /F1 18 Tf 20 100 Td (${line}) Tj ET`
  return Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
    'latin1'
  )
}
// A Word file with two paragraphs.
const docx = async (paras: string[]): Promise<Buffer> => {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('reading files and links', () => {
  it('reads a PDF, a Word file, a spreadsheet, a CSV and text', async () => {
    expect(await extractFile('contrato.pdf', pdf('Contrato Silva e Souza'))).toContain('Contrato Silva e Souza')
    expect(await extractFile('contrato.docx', await docx(['Cliente: Silva & Souza', 'Valor: R$ 4.800']))).toBe('Cliente: Silva &amp; Souza\n\nValor: R$ 4.800'.replace('&amp;', '&'))
    const book = new ExcelJS.Workbook()
    const sheet = book.addWorksheet('Gastos')
    sheet.addRow(['Mês', 'Mercado'])
    sheet.addRow(['Outubro', 1390])
    expect(await extractFile('gastos.xlsx', Buffer.from(await book.xlsx.writeBuffer()))).toBe('## Gastos\n\n| Mês | Mercado |\n| --- | --- |\n| Outubro | 1390 |')
    expect(await extractFile('g.csv', Buffer.from('nome;valor\n"Silva; Souza";4800\n'))).toContain('| Silva; Souza | 4800 |')
    expect(await extractFile('n.md', Buffer.from('# Nota\n\nTexto.'))).toBe('# Nota\n\nTexto.')
    await expect(extractFile('foto.heic', Buffer.from('x'))).rejects.toThrow('.heic')
  })

  it('splits CSV with quotes, commas and line breaks inside', () => {
    expect(parseCsv('a,b\n"x, y","linha\nquebrada"\n')).toEqual([['a', 'b'], ['x, y', 'linha\nquebrada']])
  })

  it("takes a page's main content, not its menu", async () => {
    const html = '<html><head><title>Guia</title></head><body><nav>Menu Início Contato</nav><article><h1>Piso vinílico</h1><p>É mais barato e rápido de instalar que o porcelanato, e aguenta bem a umidade da cozinha.</p><ul><li>Prazo médio: 45 dias</li></ul></article><footer>Rodapé</footer></body></html>'
    const page = await extractLink('https://exemplo.com/guia', (async () => new Response(html, { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch)
    expect(page.title).toBe('Guia')
    expect(page.text).toContain('aguenta bem a umidade')
    expect(page.text).toContain('- Prazo médio: 45 dias')
    expect(page.text).not.toContain('Rodapé')
    await expect(extractLink('ftp://x')).rejects.toThrow('http')
  })
})

describe('a document brought to the wiki', () => {
  it('keeps the original, reads it in parts and turns it into pages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tucano-wiki-'))
    const w = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db') })
    w.init(false)
    const prompts: string[] = []
    const curator = new WikiCurator({
      wiki: w,
      db: { conversation: () => undefined, messagesAfter: () => [], message: () => undefined, saveMessage: () => {}, agents: () => [] },
      settings: () => ({ workspaceName: 'Ana' }) as Settings,
      llm: async (_s, prompt) => {
        prompts.push(prompt)
        const part = /parte (\d) de/.exec(prompt)?.[1] ?? '1'
        return JSON.stringify({ guardar: true, titulo_fonte: 'Contrato', mudancas: [{ op: 'create', pagina: `Cláusulas ${part}`, tipo: 'Assunto', texto: `Parte ${part} do contrato.` }] })
      },
      emitMessage: () => {}
    })
    const long = Array.from({ length: 30 }, (_, k) => `Cláusula ${k + 1}. ${'Texto do contrato. '.repeat(120)}`).join('\n\n')
    const src = w.addSource({ title: 'Contrato Silva', text: long, kind: 'file', file: { name: 'contrato.pdf', data: Buffer.from('%PDF') }, by: 'me', status: 'reading' })
    expect(existsSync(w.originalPath(src.id)!)).toBe(true)
    expect(readFileSync(w.originalPath(src.id)!, 'utf8')).toBe('%PDF')
    await curator.ingest(src.id)
    expect(prompts.length).toBeGreaterThan(1)
    expect(prompts[0]).toContain('documento que a pessoa trouxe')
    expect(w.source(src.id)).toMatchObject({ status: 'done', changes: prompts.length })
    expect(w.page('Cláusulas 1')!.body).toMatch(/Fontes: \[\[fontes\/.+\|Contrato Silva\]\]/)

    // a note: kept on purpose; a curator that fails marks the source as failed
    const broken = new WikiCurator({ wiki: w, db: { conversation: () => undefined, messagesAfter: () => [], message: () => undefined, saveMessage: () => {}, agents: () => [] }, settings: () => ({}) as Settings, llm: async () => { throw new Error('sem modelo') }, emitMessage: () => {} })
    const note = w.addSource({ title: 'Lembrete', text: 'O Marcos prefere WhatsApp depois das 18h.', kind: 'note', by: 'me', status: 'reading' })
    await broken.ingest(note.id)
    expect(w.source(note.id)).toMatchObject({ status: 'failed', error: 'sem modelo' })
  })
})
