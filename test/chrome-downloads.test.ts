import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChromeBrowsers, hasChrome } from '../src/core/chrome'
import { downloadsFolder, downloadsSince, listDownloads } from '../src/core/downloads'
import { MAX_FILE_BYTES, type BrowserReply } from '../src/shared/types'

const PASSWORD = 'luz-S3nha!secreta'
const PDF = '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
const until = async (ok: () => boolean, ms = 20_000): Promise<void> => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 200))
}

describe.skipIf(!hasChrome())('downloads and saved logins in a real Chrome', () => {
  let server: Server
  let url = ''
  let dataDir = ''
  let chrome: ChromeBrowsers
  const ref = (snap: BrowserReply, label: string): number => snap.elements!.find((e) => e.label === label)!.ref

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/fatura') return void res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="fatura-nov.pdf"' }).end('%PDF-1.4 fatura de novembro')
      if (req.url === '/enorme') return void res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="enorme.zip"' }).end(Buffer.alloc(MAX_FILE_BYTES + 1024 * 1024, 1))
      if (req.url === '/segunda-via.pdf') return void res.writeHead(200, { 'content-type': 'application/pdf' }).end(PDF)
      if (req.url === '/arquivos') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<title>contas</title><a href="/fatura">Baixar fatura</a> <a href="/enorme">Baixar tudo</a> <a href="/segunda-via.pdf">Segunda via</a>')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        `<title>entrar</title>
        <input type="email" aria-label="Email"> <input id="p" type="password" aria-label="Senha"> <input aria-label="Nome">
        <button onclick="document.getElementById('p').type = 'text'">Mostrar senha</button>
        <div id="eco"></div>
        <script>document.getElementById('p').oninput = (e) => (document.getElementById('eco').textContent = 'Você digitou ' + e.target.value)</script>`
      )
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    dataDir = mkdtempSync(join(tmpdir(), 'tucano-chrome-dl-'))
    chrome = new ChromeBrowsers(join(dataDir, 'navegador'), () => {}, undefined, undefined, false, undefined, (agentId) => downloadsFolder(dataDir, agentId))
  })

  afterAll(() => {
    chrome.quit()
    server.close()
  })

  it('downloads land in the agent’s folder under their own name; one over the limit is refused', async () => {
    const folder = downloadsFolder(dataDir, 'ada')
    await chrome.run('ada', 'open', { url: `${url}/arquivos` })
    let snap = await chrome.run('ada', 'snapshot')
    const t0 = Date.now()
    await chrome.run('ada', 'click', { ref: ref(snap, 'Baixar fatura') })
    await until(() => listDownloads(folder).length > 0)
    expect(listDownloads(folder).map((f) => f.name)).toEqual(['fatura-nov.pdf'])
    expect(readFileSync(join(folder, 'fatura-nov.pdf'), 'utf8')).toBe('%PDF-1.4 fatura de novembro')

    snap = await chrome.run('ada', 'snapshot')
    await chrome.run('ada', 'click', { ref: ref(snap, 'Baixar tudo') })
    await until(() => downloadsSince(folder, t0).some((n) => n.refused))
    expect(downloadsSince(folder, t0).find((n) => n.refused)).toMatchObject({ name: 'enorme.zip', refused: 'too-big' })
    await until(() => !existsSync(join(folder, 'enorme.zip')) && listDownloads(folder).length === 1, 3000)
    expect(listDownloads(folder).map((f) => f.name)).toEqual(['fatura-nov.pdf'])

    // A PDF the site shows instead of offering: it downloads too, rather than opening in a viewer.
    snap = await chrome.run('ada', 'snapshot')
    await chrome.run('ada', 'click', { ref: ref(snap, 'Segunda via') })
    await until(() => listDownloads(folder).length === 2)
    expect(listDownloads(folder).map((f) => f.name).sort()).toEqual(['fatura-nov.pdf', 'segunda-via.pdf'])
  }, 90_000)

  it('types a saved password only into a password field on its origin, and never shows it again', async () => {
    const origin = new URL(url).origin
    await chrome.run('ada', 'open', { url: `${url}/entrar` })
    let snap = await chrome.run('ada', 'snapshot')
    const senha = ref(snap, 'Senha')
    await expect(chrome.run('ada', 'fill', { ref: senha, text: PASSWORD, origin: 'https://outro.site', password: true })).rejects.toThrow()
    await expect(chrome.run('ada', 'fill', { ref: ref(snap, 'Nome'), text: PASSWORD, origin, password: true })).rejects.toThrow()

    await chrome.run('ada', 'fill', { ref: ref(snap, 'Email'), text: 'edu@exemplo.com', origin, password: false })
    snap = await chrome.run('ada', 'snapshot')
    await chrome.run('ada', 'fill', { ref: ref(snap, 'Senha'), text: PASSWORD, origin, password: true })
    snap = await chrome.run('ada', 'snapshot')
    expect(snap.elements!.find((e) => e.label === 'Email')!.value).toBe('edu@exemplo.com')
    expect(snap.elements!.find((e) => e.label === 'Senha')!.value).toBe('••••')

    // The page's own "show password", and the page echoing what was typed: still dots.
    await chrome.run('ada', 'click', { ref: ref(snap, 'Mostrar senha') })
    snap = await chrome.run('ada', 'snapshot')
    const read = await chrome.run('ada', 'text')
    expect(JSON.stringify({ snap, read })).not.toContain(PASSWORD)
    expect(read.text).toContain('Você digitou ••••')
  }, 90_000)
})
