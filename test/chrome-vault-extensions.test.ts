// An extension reads every page it is on, what is typed there included, so a Cofre login must never reach a
// page in a browser that carries one. This runs the real ChromeBrowsers and the real navegador_login over a
// stand-in Chrome: a small program that speaks the DevTools pipe and writes down, for every process, whether
// it was started with extensions and every text typed into it. It runs on any computer, with no Chrome.
import { chmodSync, copyFileSync, existsSync, linkSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Browser } from '../src/core/browser'
import { ChromeBrowsers } from '../src/core/chrome'
import { findOnPath } from '../src/core/platform'
import type { Db } from '../src/core/db'
import { setLang } from '../src/shared/lang'
import { SNAPSHOT } from '../src/shared/page'
import type { Agent } from '../src/shared/types'

const USERNAME = 'edu@exemplo.com'
const PASSWORD = 'luz-S3nha!secreta'
const SITE = 'https://conta.luz.com.br'
const PAGE = `${SITE}/entrar`

const STAND_IN = String.raw`
const net = require('node:net')
const fs = require('node:fs')
const [log, snapshot] = [process.env.FAKE_CHROME_LOG, fs.readFileSync(process.env.FAKE_CHROME_SNAPSHOT, 'utf8')]
const args = process.argv.slice(2)
const extensions = args.some((a) => a.startsWith('--load-extension='))
const profile = (args.find((a) => a.startsWith('--user-data-dir=')) || '').slice('--user-data-dir='.length)
const note = (o) => fs.appendFileSync(log, JSON.stringify({ pid: process.pid, extensions, profile, ...o }) + '\n')
note({ started: true, headed: args.includes('--new-window') })
let url = 'about:blank'
const out = new net.Socket({ fd: 4, readable: false, writable: true })
const input = new net.Socket({ fd: 3, readable: true, writable: false })
const elements = [{ ref: 1, role: 'campo', label: 'Email', inView: true }, { ref: 2, role: 'campo', label: 'Senha', inView: true }]
const value = (code) => {
  if (code === snapshot) return { url, title: 'Luz', w: 1280, h: 800, elements }
  if (code === 'location.href') return url
  if (code === 'document.readyState') return 'complete'
  if (code.startsWith('({ url: location.href')) return { url, title: 'Luz', w: 1280, h: 800 }
  return { x: 10, y: 10 }
}
const results = {
  'Target.getTargets': () => ({ targetInfos: [{ targetId: 't1', type: 'page', url }] }),
  'Target.attachToTarget': () => ({ sessionId: 's1' }),
  'Target.getTargetInfo': () => ({ targetInfo: { url } }),
  'Browser.getVersion': () => ({ userAgent: 'HeadlessChrome/158.0.0.0' }),
  'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'f1' } } }),
  'Page.createIsolatedWorld': () => ({ executionContextId: 1 }),
  'Page.captureScreenshot': () => ({ data: '' })
}
let buffered = ''
input.setEncoding('utf8')
input.on('data', (chunk) => {
  const parts = (buffered + chunk).split('\0')
  buffered = parts.pop()
  for (const raw of parts) {
    if (!raw) continue
    const { id, method, params = {} } = JSON.parse(raw)
    if (method === 'Page.navigate') {
      url = params.url
      note({ navigated: url })
      out.write(JSON.stringify({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 't1', type: 'page', url } } }) + '\0')
    }
    if (method === 'Input.insertText') note({ typed: params.text })
    const result = method === 'Runtime.evaluate' ? { result: { value: value(params.expression) } } : (results[method] || (() => ({})))()
    out.write(JSON.stringify({ id, result }) + '\0')
    if (method === 'Browser.close') setTimeout(() => process.exit(0), 10)
  }
})
input.on('close', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
`

type Line = { pid: number; extensions: boolean; profile: string; started?: boolean; headed?: boolean; navigated?: string; typed?: string }

const agent = { id: 'lia-0001', name: 'Lia', browser: true } as Agent
const ctx = { conversationId: 'c1', messageId: 'm1' }
const text = (r: { content: unknown[] }): string => (r.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n')

describe('a Cofre login and the browser’s extensions', () => {
  let dir = ''
  let bin = ''
  let log = ''
  let lanes: ChromeBrowsers[] = []
  const addOns = { bin: '', dirs: ['/extensions/ublock'] }
  const lines = (): Line[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line) : [])
  const typed = (): Line[] => lines().filter((l) => l.typed !== undefined)
  const started = (): Line[] => lines().filter((l) => l.started)
  const lane = (): ChromeBrowsers => {
    const chrome = new ChromeBrowsers(join(dir, 'navegador'), () => {}, bin, undefined, false, undefined, undefined, addOns)
    lanes.push(chrome)
    return chrome
  }
  const over = (chrome: ChromeBrowsers): Browser =>
    new Browser({
      host: (id, op, args) => chrome.run(id, op, args),
      db: {} as Db,
      dataDir: dir,
      emit: () => {},
      me: () => 'Edu',
      logins: { loginSites: () => [SITE], loginFor: async () => ({ username: USERNAME, password: PASSWORD }) }
    })
  const login = (browser: Browser) => browser.call(agent, 'navegador_login', { usuario: '#1', senha: '#2' }, ctx)

  beforeEach(() => {
    setLang('en')
    dir = mkdtempSync(join(tmpdir(), 'tucano-vault-lane-'))
    log = join(dir, 'chrome.log')
    const program = join(dir, 'stand-in.cjs')
    writeFileSync(program, STAND_IN)
    writeFileSync(join(dir, 'snapshot.txt'), SNAPSHOT)
    // The stand-in is started the way the app starts Chrome. On a Mac and Linux that is a shell script. On
    // Windows Node runs neither a .cmd nor a .bat itself, and the app starts the browser through
    // core/platform.ts's spawnable(): a shim in npm's own shape, node with this script and the switches, is
    // unwrapped there into that node and script directly, not through cmd.exe, so the DevTools pipe reaches
    // the program on fd 3 and 4 as it does on the other two systems. It names `node`, which spawnable()
    // finds on the PATH; one beside the shim (a hard link, never a 105 MB copy) is the fallback for a
    // computer whose PATH has none.
    if (process.platform === 'win32') {
      bin = join(dir, 'chrome.cmd')
      if (!findOnPath('node')) {
        try {
          linkSync(process.execPath, join(dir, 'node.exe'))
        } catch {
          copyFileSync(process.execPath, join(dir, 'node.exe')) // another volume: a link is impossible
        }
      }
      writeFileSync(bin, `@"%~dp0\\node.exe" "%~dp0\\stand-in.cjs" %*\r\n`)
    } else {
      bin = join(dir, 'chrome')
      writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${program}" "$@"\n`)
      chmodSync(bin, 0o755)
    }
    process.env['FAKE_CHROME_LOG'] = log
    process.env['FAKE_CHROME_SNAPSHOT'] = join(dir, 'snapshot.txt')
    addOns.bin = bin
    addOns.dirs = ['/extensions/ublock']
    lanes = []
  })
  afterEach(async () => {
    for (const chrome of lanes) await chrome.run(agent.id, 'close').catch(() => {})
    for (const chrome of lanes) chrome.quit()
  })

  it('reopens a lane with extensions without them, on the same address, before anything is typed', async () => {
    const chrome = lane()
    await chrome.run(agent.id, 'open', { url: PAGE })
    expect(started().at(-1)?.extensions).toBe(true)

    const first = await login(over(chrome))
    expect(first.result.isError, text(first.result)).toBeFalsy()
    expect(text(first.result)).toContain('reopened the browser without its extensions')
    expect(text(first.result)).toContain('Email') // the current page, for the numbers to use
    expect(typed()).toEqual([]) // nothing was typed anywhere yet
    expect(started().at(-1)?.extensions).toBe(false)
    expect(started().at(-1)?.profile).toBe(join(dir, 'navegador', agent.id)) // the profile that keeps its logins
    expect(lines().filter((l) => l.navigated === PAGE).at(-1)?.extensions).toBe(false)
  }, 30_000)

  it('never types a secret into a process that carries an extension, and does not relaunch again', async () => {
    const chrome = lane()
    const browser = over(chrome)
    await chrome.run(agent.id, 'open', { url: PAGE })
    await login(browser)
    const launches = started().length

    const second = await login(browser)
    expect(second.result.isError, text(second.result)).toBeFalsy()
    await login(browser)
    expect(typed().map((l) => l.typed)).toEqual([USERNAME, PASSWORD, USERNAME, PASSWORD])
    expect(typed().every((l) => !l.extensions)).toBe(true)
    expect(started()).toHaveLength(launches) // no relaunch loop
  }, 30_000)

  it('refuses a fill on a lane with extensions, whatever led there', async () => {
    const chrome = lane()
    await chrome.run(agent.id, 'open', { url: PAGE })
    await expect(chrome.run(agent.id, 'fill', { ref: 2, text: PASSWORD, origin: SITE, password: true })).rejects.toThrow(/has extensions in it/)
    expect(typed()).toEqual([])
  }, 30_000)

  it('keeps the agent off extensions afterwards: a switch, a restart and a window do not bring them back', async () => {
    const chrome = lane()
    const browser = over(chrome)
    await chrome.run(agent.id, 'open', { url: PAGE })
    await login(browser)
    await login(browser)

    addOns.dirs = ['/extensions/ublock', '/extensions/consent'] // another switch turned on
    await chrome.run(agent.id, 'snapshot')
    expect(started().at(-1)?.extensions).toBe(false)

    await chrome.run(agent.id, 'close')
    const next = lane() // the app started again
    await next.run(agent.id, 'open', { url: PAGE })
    expect(started().at(-1)?.extensions).toBe(false)
    await next.run(agent.id, 'show')
    expect(started().at(-1)).toMatchObject({ extensions: false, headed: true })
    expect(lines().filter((l) => l.extensions && l.typed !== undefined)).toEqual([])
  }, 30_000)

  it('leaves a window the person is using alone, and types nothing into it', async () => {
    const chrome = lane()
    await chrome.run(agent.id, 'open', { url: PAGE })
    await chrome.run(agent.id, 'show')
    expect(started().at(-1)).toMatchObject({ extensions: true, headed: true })
    const launches = started().length
    await expect(chrome.run(agent.id, 'prepare_login')).rejects.toThrow(/has extensions in it/)
    expect(started()).toHaveLength(launches)
    expect(typed()).toEqual([])
  }, 30_000)

  it('gives the extensions back once the browser is cleared, with the logins it held gone too', async () => {
    const chrome = lane()
    const browser = over(chrome)
    await chrome.run(agent.id, 'open', { url: PAGE })
    await login(browser)
    await chrome.run(agent.id, 'clear')
    await chrome.run(agent.id, 'open', { url: PAGE })
    expect(started().at(-1)?.extensions).toBe(true)
  }, 30_000)

  it('does not touch a lane with no extensions: the login goes straight through', async () => {
    addOns.dirs = []
    const chrome = lane()
    await chrome.run(agent.id, 'open', { url: PAGE })
    const launches = started().length
    const r = await login(over(chrome))
    expect(text(r.result)).not.toContain('reopened')
    expect(typed().map((l) => l.typed)).toEqual([USERNAME, PASSWORD])
    expect(started()).toHaveLength(launches)
  }, 30_000)
})
