import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChromeBrowsers } from '../src/core/chrome'

// The extension is the point: a real one, unpacked in a folder, whose content script writes a paragraph
// into every page it lands on. If the paragraph is in the text the agent reads, Chrome took the folder.
const MARK = 'the add-on is here'
const PAGE = '<!doctype html><title>page</title><p>the site</p>'

// Chrome only takes a folder of extensions in a build that still honours --load-extension, and the
// branded one stopped in 158 (measured here 2026-11-22: it loaded its own three built-ins and nothing
// else). So this runs where a Chrome for Testing is pointed at — TUCANO_CFT, its program path — and
// skips elsewhere, the way the other Chrome tests skip on a computer with none.
const CFT = process.env['TUCANO_CFT'] ?? ''

const addOn = (dir: string): string => {
  mkdirSync(join(dir, 'addon'), { recursive: true })
  writeFileSync(join(dir, 'addon', 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Tucano test add-on', version: '1.0', content_scripts: [{ matches: ['http://*/*'], js: ['add.js'], run_at: 'document_idle' }] }))
  writeFileSync(join(dir, 'addon', 'add.js'), `document.body.insertAdjacentHTML('beforeend', '<p>${MARK}</p>')`)
  return join(dir, 'addon')
}

describe.skipIf(!CFT || !existsSync(CFT))('a lane with the add-ons in it', () => {
  let server: Server
  let url = ''
  let dir = ''
  let folder = ''
  let withAddOns: ChromeBrowsers
  let without: ChromeBrowsers

  beforeAll(async () => {
    server = createServer((_req, res) => void res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    dir = mkdtempSync(join(tmpdir(), 'tucano-addons-'))
    folder = addOn(dir)
    const profiles = (...a: ConstructorParameters<typeof ChromeBrowsers>) => new ChromeBrowsers(...a)
    // The same browser, the same page: one lane carries the extension, the other is the control.
    withAddOns = profiles(join(dir, 'a'), () => {}, CFT, undefined, false, undefined, undefined, { bin: CFT, dirs: [folder] })
    without = profiles(join(dir, 'b'), () => {}, CFT)
  })

  afterAll(async () => {
    await withAddOns.run('lane', 'close').catch(() => {})
    await without.run('lane', 'close').catch(() => {})
    await new Promise((r) => server.close(r))
  })

  it('carries the extension into the page the agent reads', async () => {
    await withAddOns.run('lane', 'open', { url })
    const text = await withAddOns.run('lane', 'text')
    expect(text.text).toContain('the site')
    expect(text.text).toContain(MARK)
  })

  it('reads the same page without it when the lane carries none', async () => {
    await without.run('lane', 'open', { url })
    const text = await without.run('lane', 'text')
    expect(text.text).toContain('the site')
    // The control: the paragraph on the first lane came from the extension, not from the page.
    expect(text.text).not.toContain(MARK)
  })

  it('leaves a throwaway screenshot out of it: that one draws the page as it is', async () => {
    await withAddOns.run('.shot-test', 'open', { url })
    const text = await withAddOns.run('.shot-test', 'text')
    expect(text.text).toContain('the site')
    expect(text.text).not.toContain(MARK)
  })
})
