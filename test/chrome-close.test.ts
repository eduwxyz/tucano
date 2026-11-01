import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChromeBrowsers, hasChrome } from '../src/core/chrome'

describe.skipIf(!hasChrome())('closing an agent’s Chrome', () => {
  let server: Server
  let url = ''
  let chrome: ChromeBrowsers

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/login') return void res.writeHead(200, { 'set-cookie': 'session=ok; Max-Age=3600; Path=/', 'content-type': 'text/html' }).end('<title>in</title>')
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<title>${/session=ok/.test(req.headers.cookie ?? '') ? 'signed in' : 'anonymous'}</title>`)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    chrome = new ChromeBrowsers(mkdtempSync(join(tmpdir(), 'tucano-chrome-')), () => {})
  })

  afterAll(() => {
    chrome.quit()
    server.close()
  })

  it('keeps a login made just before', async () => {
    await chrome.run('ada', 'open', { url: `${url}login` })
    expect((await chrome.run('ada', 'open', { url })).title).toBe('signed in')
    await chrome.run('ada', 'close')
    expect((await chrome.run('ada', 'open', { url })).title).toBe('signed in')
  }, 60_000)
})
