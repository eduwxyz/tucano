// Codex and Claude Code set up with no terminal (src/core/engine-setup.ts): what to download for each
// system, the published checksum checked before anything is kept, the CLI's own sign-in driven as a
// process (its page's address read from its output), and what a failure or a cancel leaves.
// The network and the processes are stand-ins here.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeBinary, claudePlatform, CLAUDE_RELEASES, CODEX_RELEASE, codexAsset, codexTarget, EngineSetup, loginUrl, type SetupDeps } from '../src/core/engine-setup'
import type { EngineStatus, SetupEngine, SetupState } from '../src/shared/types'

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

describe('what to download', () => {
  it("names Codex's build and Claude Code's platform for each system", () => {
    expect(codexTarget('mac', 'arm64')).toBe('aarch64-apple-darwin')
    expect(codexTarget('mac', 'x64')).toBe('x86_64-apple-darwin')
    expect(codexTarget('linux', 'x64')).toBe('x86_64-unknown-linux-musl')
    expect(codexTarget('linux', 'arm64')).toBe('aarch64-unknown-linux-musl')
    expect(codexTarget('windows', 'x64')).toBe('x86_64-pc-windows-msvc')
    expect(codexTarget('windows', 'arm64')).toBe('aarch64-pc-windows-msvc')
    expect(codexTarget('linux', 'ia32')).toBeUndefined()
    expect(claudePlatform('mac', 'arm64')).toBe('darwin-arm64')
    expect(claudePlatform('windows', 'x64')).toBe('win32-x64')
    expect(claudePlatform('linux', 'x64')).toBe('linux-x64')
    expect(claudePlatform('linux', 'arm64', true)).toBe('linux-arm64-musl')
    expect(claudePlatform('windows', 'ia32')).toBeUndefined()
  })

  it("takes Codex's package from the release, with its published sha256", () => {
    const digest = 'a'.repeat(64)
    const release = { tag_name: 'rust-v0.167.0', assets: [{ name: 'codex-aarch64-apple-darwin.tar.gz', browser_download_url: 'https://x/plain', digest: `sha256:${'b'.repeat(64)}` }, { name: 'codex-package-aarch64-apple-darwin.tar.gz', browser_download_url: 'https://x/pkg', digest: `sha256:${digest}` }] }
    expect(codexAsset(release, 'aarch64-apple-darwin')).toEqual({ version: '0.167.0', url: 'https://x/pkg', sha256: digest })
    expect(codexAsset(release, 'x86_64-pc-windows-msvc')).toBeUndefined()
    // Nothing without a checksum to check against.
    expect(codexAsset({ ...release, assets: [{ ...release.assets[1]!, digest: undefined }] }, 'aarch64-apple-darwin')).toBeUndefined()
    expect(codexAsset(null, 'aarch64-apple-darwin')).toBeUndefined()
  })

  it("takes Claude Code's binary from the version's manifest, only with a checksum", () => {
    const checksum = 'c'.repeat(64)
    const manifest = { platforms: { 'darwin-arm64': { checksum, size: 1 }, 'win32-x64': { checksum, binary: 'claude.exe' } } }
    expect(claudeBinary(manifest, '2.1.319', 'darwin-arm64')).toEqual({ version: '2.1.319', url: `${CLAUDE_RELEASES}/2.1.319/darwin-arm64/claude`, sha256: checksum })
    expect(claudeBinary(manifest, '2.1.319', 'win32-x64')?.url).toBe(`${CLAUDE_RELEASES}/2.1.319/win32-x64/claude.exe`)
    expect(claudeBinary(manifest, '2.1.319', 'linux-x64')).toBeUndefined()
    expect(claudeBinary({ platforms: { 'darwin-arm64': { checksum: 'nope' } } }, '2.1.319', 'darwin-arm64')).toBeUndefined()
    expect(claudeBinary(manifest, '<html>', 'darwin-arm64')).toBeUndefined()
    // A name that would leave the folder isn't taken.
    expect(claudeBinary({ platforms: { 'darwin-arm64': { checksum, binary: '../x' } } }, '2.1.319', 'darwin-arm64')?.url).toBe(`${CLAUDE_RELEASES}/2.1.319/darwin-arm64/claude`)
  })

  it('reads the sign-in page from what the CLI prints, colors and hyperlinks aside', () => {
    const codex = 'Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&state=abc\n\n'
    expect(loginUrl(codex)).toBe('https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&state=abc')
    const claude = "Opening browser to sign in…\nIf the browser didn't open, visit: \x1b]8;;https://claude.ai/oauth/authorize?code=true&state=s1\x07https://claude.ai/oauth/authorize?code=true&state=s1\x1b]8;;\x07\nPaste code here if prompted > "
    expect(loginUrl(claude)).toBe('https://claude.ai/oauth/authorize?code=true&state=s1')
    expect(loginUrl('\x1b[1mhttps://example.com/a\x1b[0m')).toBe('https://example.com/a')
    expect(loginUrl('nothing yet')).toBeUndefined()
  })
})

// A fake network: each URL answers what's given; a body is streamed in two pieces.
function network(routes: Record<string, unknown>): { fetch: typeof fetch; asked: string[] } {
  const asked: string[] = []
  const fetch: typeof globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url)
    asked.push(u)
    const v = routes[u]
    if (v === undefined) return new Response('nope', { status: 404 })
    if (Buffer.isBuffer(v)) {
      const half = Math.floor(v.length / 2)
      const body = new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array(v.subarray(0, half))), c.enqueue(new Uint8Array(v.subarray(half))), c.close()) })
      return new Response(body, { headers: { 'content-length': String(v.length) } })
    }
    return new Response(typeof v === 'string' ? v : JSON.stringify(v))
  }) as typeof globalThis.fetch
  return { fetch, asked }
}

// A fake CLI sign-in: prints, then ends with `code` (or never, until killed).
function signIn(print: string, code: number | null): { spawn: SetupDeps['spawn']; runs: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[]; killed: () => boolean } {
  const runs: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
  let killed = false
  return {
    runs,
    killed: () => killed,
    spawn: (bin, args, env) => {
      runs.push({ bin, args, env })
      let end: (c: number) => void = () => {}
      const exit = new Promise<number>((r) => (end = r))
      return {
        output: (on) => setTimeout(() => {
          on(print)
          if (code !== null) end(code)
        }, 1),
        exit,
        kill: () => ((killed = true), end(143))
      }
    }
  }
}

function setup(over: Partial<SetupDeps> & { start?: EngineStatus; after?: EngineStatus }): { s: EngineSetup; dir: string; seen: SetupState[] } {
  const dir = mkdtempSync(join(tmpdir(), 'tucano-setup-'))
  let status: EngineStatus = over.start ?? { installed: false, loggedIn: false }
  const seen: SetupState[] = []
  const s: EngineSetup = new EngineSetup({
    dir,
    os: 'mac',
    arch: 'arm64',
    musl: () => false,
    fetch: network({}).fetch,
    untar: async () => {},
    spawn: signIn('', 0).spawn,
    status: () => status,
    recheck: async () => (status = over.after ?? { installed: true, loggedIn: true, path: '/x' }),
    env: (e: SetupEngine) => ({ WHO: e }),
    changed: () => void (s?.current && seen.push(s.current)),
    ...over
  })
  return { s, dir, seen }
}

const until = async (s: EngineSetup): Promise<void> => {
  for (let i = 0; i < 200 && s.current?.state === 'running'; i++) await new Promise((r) => setTimeout(r, 5))
}

describe('setting up Claude Code', () => {
  const binary = Buffer.from('the claude binary')
  const routes = (checksum = sha(binary)): Record<string, unknown> => ({
    [`${CLAUDE_RELEASES}/latest`]: '2.1.319\n',
    [`${CLAUDE_RELEASES}/2.1.319/manifest.json`]: { platforms: { 'darwin-arm64': { checksum } } },
    [`${CLAUDE_RELEASES}/2.1.319/darwin-arm64/claude`]: binary
  })

  it("downloads the checked binary into the app's folder, puts it on the PATH after the person's, then runs its own sign-in", async () => {
    const net = network(routes())
    const cli = signIn("Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.ai/oauth/authorize?x=1\n", 0)
    const { s, dir, seen } = setup({ fetch: net.fetch, spawn: cli.spawn, after: { installed: true, loggedIn: false, path: '/dl/claude' } })
    let checks = 0
    // Installed and signed out after the download; signed in after the sign-in.
    ;(s as unknown as { deps: SetupDeps }).deps.recheck = async () => (++checks === 1 ? { installed: true, loggedIn: false, path: '/dl/claude' } : { installed: true, loggedIn: true, path: '/dl/claude' })
    s.start('claude')
    await until(s)
    expect(s.current).toMatchObject({ engine: 'claude', step: 'login', state: 'done' })
    // On the way: the download's progress, then the sign-in with its page, for "Abrir de novo".
    expect(seen.some((x) => x.step === 'install' && (x.progress ?? 0) > 0)).toBe(true)
    expect(seen.some((x) => x.step === 'login' && x.state === 'running' && x.url === 'https://claude.ai/oauth/authorize?x=1')).toBe(true)
    const bin = join(dir, 'claude', '2.1.319', 'claude')
    expect(readFileSync(bin, 'utf8')).toBe('the claude binary')
    expect(existsSync(`${bin}.part`)).toBe(false)
    expect(s.dirs()).toEqual([join(dir, 'claude', '2.1.319')])
    expect(s.withDirs(['/usr/bin', '/opt/homebrew/bin'].join(delimiter))).toBe(['/usr/bin', '/opt/homebrew/bin', join(dir, 'claude', '2.1.319')].join(delimiter))
    // The CLI's own sign-in, with the binary it just got.
    expect(cli.runs).toEqual([{ bin, args: ['auth', 'login'], env: { WHO: 'claude' } }])
  })

  it('keeps nothing when the file doesn\'t match the published checksum', async () => {
    const { s, dir } = setup({ fetch: network(routes('d'.repeat(64))).fetch })
    s.start('claude')
    await until(s)
    expect(s.current).toMatchObject({ step: 'install', state: 'error' })
    expect(s.current?.error).toMatch(/não bate|doesn't match/)
    expect(existsSync(join(dir, 'claude', '2.1.319', 'claude'))).toBe(false)
    expect(existsSync(join(dir, 'claude', '2.1.319', 'claude.part'))).toBe(false)
    expect(s.dirs()).toEqual([])
  })

  it('says so when the release server is out of reach', async () => {
    const { s } = setup({ fetch: network({}).fetch })
    s.start('claude')
    await until(s)
    expect(s.current).toMatchObject({ step: 'install', state: 'error' })
  })

  it("has no build for a system it doesn't support", async () => {
    const { s } = setup({ arch: 'ia32' })
    s.start('claude')
    await until(s)
    expect(s.current?.error).toMatch(/não tem uma versão|no build/)
  })
})

describe('setting up Codex', () => {
  const pkg = Buffer.from('a tarball')
  const release = { tag_name: 'rust-v0.167.0', assets: [{ name: 'codex-package-x86_64-pc-windows-msvc.tar.gz', browser_download_url: 'https://dl/pkg.tgz', digest: `sha256:${sha(pkg)}` }] }

  it("unpacks the package, finds its CLI by the package's own entry point, and signs in into the app's Codex home", async () => {
    const untarred: string[] = []
    const cli = signIn('Starting local login server on http://localhost:1455.\nhttps://auth.openai.com/oauth/authorize?a=1\nSuccessfully logged in\n', 0)
    const { s, dir, seen } = setup({
      os: 'windows',
      arch: 'x64',
      fetch: network({ [CODEX_RELEASE]: release, 'https://dl/pkg.tgz': pkg }).fetch,
      spawn: cli.spawn,
      untar: async (archive, into) => {
        untarred.push(readFileSync(archive, 'utf8'))
        mkdirSync(join(into, 'bin'), { recursive: true })
        writeFileSync(join(into, 'bin', 'codex.exe'), '')
        writeFileSync(join(into, 'codex-package.json'), JSON.stringify({ entrypoint: 'bin/codex' }))
      }
    })
    let checks = 0
    ;(s as unknown as { deps: SetupDeps }).deps.recheck = async () => (++checks === 1 ? { installed: true, loggedIn: false } : { installed: true, loggedIn: true })
    s.start('codex')
    await until(s)
    expect(untarred).toEqual(['a tarball'])
    expect(s.current).toMatchObject({ engine: 'codex', step: 'login', state: 'done' })
    expect(seen.some((x) => x.url === 'https://auth.openai.com/oauth/authorize?a=1')).toBe(true)
    const bin = join(dir, 'codex', '0.167.0', 'bin', 'codex.exe')
    expect(cli.runs).toEqual([{ bin, args: ['login'], env: { WHO: 'codex' } }])
    expect(s.dirs()).toEqual([join(dir, 'codex', '0.167.0', 'bin')])
    expect(existsSync(join(dir, 'codex', '0.167.0.tar.gz'))).toBe(false) // the archive goes once unpacked
  })

  it('skips the download when the CLI is there, and the sign-in when it is signed in', async () => {
    const net = network({})
    const cli = signIn('', 0)
    const { s } = setup({ fetch: net.fetch, spawn: cli.spawn, start: { installed: true, loggedIn: true, path: '/usr/local/bin/codex' } })
    s.start('codex')
    await until(s)
    expect(s.current).toMatchObject({ step: 'login', state: 'done' })
    expect(net.asked).toEqual([])
    expect(cli.runs).toEqual([])
  })

  it('uses the CLI the person has, for a sign-in only', async () => {
    const net = network({})
    const cli = signIn('', 0)
    const { s } = setup({ fetch: net.fetch, spawn: cli.spawn, start: { installed: true, loggedIn: false, path: '/usr/local/bin/codex' }, after: { installed: true, loggedIn: true } })
    s.start('codex')
    await until(s)
    expect(net.asked).toEqual([])
    expect(cli.runs.map((r) => [r.bin, ...r.args])).toEqual([['/usr/local/bin/codex', 'login']])
    expect(s.current).toMatchObject({ state: 'done' })
  })

  it("says the sign-in didn't work, with the CLI's last words, when it ends badly", async () => {
    const cli = signIn('Error logging in: the state did not match\n', 1)
    const { s } = setup({ spawn: cli.spawn, start: { installed: true, loggedIn: false, path: '/x/codex' }, after: { installed: true, loggedIn: false } })
    s.start('codex')
    await until(s)
    expect(s.current).toMatchObject({ step: 'login', state: 'error' })
    expect(s.current?.error).toContain('the state did not match')
  })

  it('stops a sign-in left open, on cancel or after its time', async () => {
    const cli = signIn('', null)
    const { s } = setup({ spawn: cli.spawn, start: { installed: true, loggedIn: false, path: '/x/codex' }, after: { installed: true, loggedIn: false } })
    s.start('codex')
    await new Promise((r) => setTimeout(r, 20))
    expect(s.current).toMatchObject({ step: 'login', state: 'running' })
    s.cancel()
    expect(s.current?.state).toBe('cancelled')
    expect(cli.killed()).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(s.current?.state).toBe('cancelled') // the ended process doesn't turn it into an error

    const late = signIn('', null)
    const t = setup({ spawn: late.spawn, timeoutMs: 15, start: { installed: true, loggedIn: false, path: '/x/codex' }, after: { installed: true, loggedIn: false } })
    t.s.start('codex')
    await until(t.s)
    expect(late.killed()).toBe(true)
    expect(t.s.current?.state).toBe('error')
  })

  it('runs one setup at a time', async () => {
    const cli = signIn('', null)
    const { s } = setup({ spawn: cli.spawn, start: { installed: true, loggedIn: false, path: '/x/codex' } })
    s.start('codex')
    expect(s.start('claude').engine).toBe('codex')
    s.cancel()
  })
})
