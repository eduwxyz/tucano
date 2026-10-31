import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChromeBrowsers, hasChrome } from '../src/core/chrome'

// Tucano as a server: taking the agent's browser over keeps it headless, and
// what I do on its picture in the panel reaches the page.
const PAGE = `<!doctype html><title>start</title>
<input id="q" style="position:fixed;top:0;left:0;width:100vw;height:100px;font-size:40px">
<div style="height:4000px"></div>
<script>q.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.title = 'sent:' + q.value })
addEventListener('scroll', () => { document.title = document.title.startsWith('sent:') ? document.title : 'scrolled' })</script>`

describe.skipIf(!hasChrome())('a windowless browser driven from the panel', () => {
  let server: Server
  let url = ''
  const shown: boolean[] = []
  let chrome: ChromeBrowsers

  beforeAll(async () => {
    server = createServer((_req, res) => void res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    chrome = new ChromeBrowsers(mkdtempSync(join(tmpdir(), 'tucano-chrome-')), (_id, s) => shown.push(s), undefined, undefined, true)
  })

  afterAll(async () => {
    await chrome.run('a', 'close').catch(() => {})
    await new Promise((r) => server.close(r))
  })

  it('takes clicks, typing and keys while taken over, and refuses them after', async () => {
    await chrome.run('a', 'open', { url })
    await expect(chrome.run('a', 'input', { kind: 'text', text: 'x' })).rejects.toThrow()

    expect((await chrome.run('a', 'show')).shown).toBe(true)
    expect(shown).toEqual([true])

    await chrome.run('a', 'input', { kind: 'click', x: 0.5, y: 0.03 })
    await chrome.run('a', 'input', { kind: 'text', text: 'olá mundo' })
    await chrome.run('a', 'input', { kind: 'key', key: 'Enter' })
    expect((await chrome.run('a', 'frame')).title).toBe('sent:olá mundo')

    expect((await chrome.run('a', 'hide')).shown).toBe(false)
    expect(shown).toEqual([true, false])
    await expect(chrome.run('a', 'input', { kind: 'key', key: 'Enter' })).rejects.toThrow()
  }, 60_000)
})
