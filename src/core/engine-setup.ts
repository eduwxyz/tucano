// Setting up Codex or Claude Code with no terminal: the official CLI, downloaded from where its own
// installer downloads it and checked against the published checksum, into a folder of the app's
// (engines/ in the data folder); then the CLI's own sign-in, which opens the browser and finishes on
// its own callback on this computer. The person signs in on OpenAI's or Anthropic's page: Tucano
// never sees a password or a token, and doesn't relay the codes (the CLI stores the login where it
// always does). The binary isn't changed, and on a machine where this can't work the screen offers
// the terminal as before.
//   Codex: github.com/openai/codex releases (codex-package-<target>.tar.gz, sha256 in the release),
//          `codex login` (browser, callback on localhost:1455).
//   Claude Code: downloads.claude.ai/claude-code-releases (manifest.json with each platform's sha256),
//          `claude auth login` (browser, callback on localhost).
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { L } from '../shared/lang'
import type { EngineStatus, Os, SetupEngine, SetupState } from '../shared/types'

export type { SetupEngine, SetupState }
export const SETUP_ENGINES: readonly SetupEngine[] = ['claude', 'codex']

export const CLAUDE_RELEASES = 'https://downloads.claude.ai/claude-code-releases'
export const CODEX_RELEASE = 'https://api.github.com/repos/openai/codex/releases/latest'

// ---------- what to download, per system (pure) ----------

export function codexTarget(os: Os, arch: string): string | undefined {
  const a = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : undefined
  if (!a) return undefined
  return os === 'mac' ? `${a}-apple-darwin` : os === 'linux' ? `${a}-unknown-linux-musl` : `${a}-pc-windows-msvc`
}

export function claudePlatform(os: Os, arch: string, musl = false): string | undefined {
  if (arch !== 'arm64' && arch !== 'x64') return undefined
  if (os === 'mac') return `darwin-${arch}`
  if (os === 'windows') return `win32-${arch}`
  return `linux-${arch}${musl ? '-musl' : ''}`
}

interface Download {
  version: string
  url: string
  sha256: string
}

// The package Codex's own installer takes (the CLI with its helpers), from a release as GitHub's API lists it.
export function codexAsset(release: unknown, target: string): Download | undefined {
  const r = release as { tag_name?: unknown; assets?: { name?: unknown; browser_download_url?: unknown; digest?: unknown }[] } | null
  const version = typeof r?.tag_name === 'string' ? r.tag_name.replace(/^rust-v/, '') : ''
  const a = r?.assets?.find((x) => x.name === `codex-package-${target}.tar.gz`)
  const sha256 = typeof a?.digest === 'string' ? a.digest.replace(/^sha256:/, '') : ''
  if (!version || typeof a?.browser_download_url !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return undefined
  return { version, url: a.browser_download_url, sha256 }
}

// Claude Code's binary for this platform, from the version's manifest.
export function claudeBinary(manifest: unknown, version: string, platform: string): Download | undefined {
  const p = (manifest as { platforms?: Record<string, { checksum?: unknown; binary?: unknown }> } | null)?.platforms?.[platform]
  const sha256 = typeof p?.checksum === 'string' ? p.checksum : ''
  if (!/^\d+\.\d+\.\d+/.test(version) || !/^[0-9a-f]{64}$/.test(sha256)) return undefined
  const binary = typeof p?.binary === 'string' && /^[\w.-]+$/.test(p.binary) ? p.binary : platform.startsWith('win32') ? 'claude.exe' : 'claude'
  return { version, url: `${CLAUDE_RELEASES}/${version}/${platform}/${binary}`, sha256 }
}

// The sign-in page a CLI printed, without the terminal's colors and hyperlink codes around it.
export function loginUrl(out: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const clean = out.replace(/\x1b\]8;[^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  return clean.match(/https:\/\/[^\s"'<>\x1b]+/)?.[0]
}

// ---------- the setup ----------

export interface SetupDeps {
  dir: string // engines/ in the data folder
  os: Os
  arch: string
  musl: () => boolean
  fetch: typeof fetch
  // tar, to unpack Codex's package (macOS, Linux and Windows 10 and later have it)
  untar: (archive: string, into: string) => Promise<void>
  // the CLI's sign-in, as a process: its output as it comes, and how it ended
  spawn: (bin: string, args: string[], env: NodeJS.ProcessEnv) => { output: (on: (text: string) => void) => void; exit: Promise<number>; kill: () => void }
  status: (engine: SetupEngine) => EngineStatus
  recheck: (engine: SetupEngine) => Promise<EngineStatus>
  env: (engine: SetupEngine) => NodeJS.ProcessEnv // where the login goes: Codex's home of the app's, Claude Code's usual one
  changed: () => void
  timeoutMs?: number // the sign-in, at most
}

export class EngineSetup {
  current: SetupState | null = null
  private abort?: AbortController
  private child?: { kill: () => void }

  constructor(private deps: SetupDeps) {}

  // The folders of the CLIs installed here, for PATH: after the person's own, which win.
  dirs(): string[] {
    try {
      const saved = JSON.parse(readFileSync(join(this.deps.dir, 'installed.json'), 'utf8')) as Record<string, unknown>
      return Object.values(saved).filter((d): d is string => typeof d === 'string' && existsSync(d))
    } catch {
      return []
    }
  }

  withDirs(path: string): string {
    const have = path.split(delimiter).filter(Boolean)
    return [...have, ...this.dirs().filter((d) => !have.includes(d))].join(delimiter)
  }

  start(engine: SetupEngine): SetupState {
    if (this.current?.state === 'running') return this.current
    this.set({ engine, step: 'install', state: 'running' })
    void this.run(engine)
    return this.current!
  }

  cancel(): void {
    if (this.current?.state !== 'running') return
    this.abort?.abort()
    this.child?.kill()
    this.set({ ...this.current, state: 'cancelled' })
  }

  private set(s: SetupState): void {
    this.current = s
    this.deps.changed()
  }

  private async run(engine: SetupEngine): Promise<void> {
    this.abort = new AbortController()
    try {
      let bin = this.deps.status(engine).installed ? this.deps.status(engine).path : undefined
      if (!bin) {
        bin = engine === 'codex' ? await this.installCodex() : await this.installClaude()
        process.env['PATH'] = this.withDirs(process.env['PATH'] ?? '')
        await this.deps.recheck(engine)
      }
      if (this.current?.state !== 'running') return
      if (this.deps.status(engine).loggedIn) return this.set({ engine, step: 'login', state: 'done' })
      this.set({ engine, step: 'login', state: 'running' })
      await this.login(engine, bin)
      const st = await this.deps.recheck(engine)
      if (this.current?.state !== 'running') return
      this.set(st.loggedIn ? { engine, step: 'login', state: 'done' } : { engine, step: 'login', state: 'error', error: L('O login não terminou. Tente de novo.', "The sign-in didn't finish. Try again.") })
    } catch (e) {
      if (this.current?.state !== 'running') return
      this.set({ ...this.current, state: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  }

  private async json(url: string): Promise<unknown> {
    const r = await this.deps.fetch(url, { signal: this.abort?.signal, headers: { accept: 'application/json', 'user-agent': 'Tucano' } })
    if (!r.ok) throw new Error(L(`Não consegui falar com ${new URL(url).host} (${r.status}).`, `Couldn't reach ${new URL(url).host} (${r.status}).`))
    return r.json()
  }

  // Downloads to a temporary file, checking the sha256 as it comes; only a match is kept.
  private async download(d: Download, to: string): Promise<void> {
    const r = await this.deps.fetch(d.url, { signal: this.abort?.signal, headers: { 'user-agent': 'Tucano' } })
    if (!r.ok || !r.body) throw new Error(L(`O download falhou (${r.status}).`, `The download failed (${r.status}).`))
    const total = Number(r.headers.get('content-length')) || 0
    const hash = createHash('sha256')
    const part = `${to}.part`
    mkdirSync(dirname(to), { recursive: true })
    const fd = openSync(part, 'w')
    let got = 0
    let shown = 0
    try {
      const reader = r.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
        writeSync(fd, value)
        got += value.length
        // A new number every couple of percent: enough to see it move.
        if (total && got / total - shown >= 0.02) this.set({ ...this.current!, progress: (shown = got / total) })
      }
    } finally {
      closeSync(fd)
    }
    if (hash.digest('hex') !== d.sha256) {
      rmSync(part, { force: true })
      throw new Error(L('O arquivo baixado não bate com o publicado. Nada foi instalado.', "The downloaded file doesn't match the published one. Nothing was installed."))
    }
    renameSync(part, to)
  }

  private remember(engine: SetupEngine, binDir: string): void {
    const file = join(this.deps.dir, 'installed.json')
    let saved: Record<string, string> = {}
    try {
      saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
    } catch {
      // the first one
    }
    writeFileSync(file, JSON.stringify({ ...saved, [engine]: binDir }, null, 2))
  }

  private async installCodex(): Promise<string> {
    const target = codexTarget(this.deps.os, this.deps.arch)
    if (!target) throw new Error(L('O Codex não tem uma versão pra este computador.', "Codex has no build for this computer."))
    const asset = codexAsset(await this.json(CODEX_RELEASE), target)
    if (!asset) throw new Error(L('Não achei o Codex pra este computador na última versão.', "Couldn't find Codex for this computer in the latest release."))
    const root = join(this.deps.dir, 'codex', asset.version)
    const archive = join(this.deps.dir, 'codex', `${asset.version}.tar.gz`)
    await this.download(asset, archive)
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    await this.deps.untar(archive, root)
    rmSync(archive, { force: true })
    // The package says where its CLI is (bin/codex); its helpers stay next to it.
    let entry = 'bin/codex'
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'codex-package.json'), 'utf8')) as { entrypoint?: unknown }
      if (typeof pkg.entrypoint === 'string' && !pkg.entrypoint.includes('..')) entry = pkg.entrypoint
    } catch {
      // an older package: the usual place
    }
    let bin = join(root, entry)
    if (this.deps.os === 'windows' && !bin.toLowerCase().endsWith('.exe')) bin += '.exe'
    if (!existsSync(bin)) throw new Error(L('O pacote do Codex veio sem o programa.', 'The Codex package came without the program.'))
    this.remember('codex', dirname(bin))
    return bin
  }

  private async installClaude(): Promise<string> {
    const platform = claudePlatform(this.deps.os, this.deps.arch, this.deps.os === 'linux' && this.deps.musl())
    if (!platform) throw new Error(L('O Claude Code não tem uma versão pra este computador.', 'Claude Code has no build for this computer.'))
    const r = await this.deps.fetch(`${CLAUDE_RELEASES}/latest`, { signal: this.abort?.signal })
    const version = r.ok ? (await r.text()).trim() : ''
    const binary = claudeBinary(await this.json(`${CLAUDE_RELEASES}/${version}/manifest.json`), version, platform)
    if (!binary) throw new Error(L('Não achei o Claude Code pra este computador na última versão.', "Couldn't find Claude Code for this computer in the latest release."))
    const binDir = join(this.deps.dir, 'claude', binary.version)
    const bin = join(binDir, this.deps.os === 'windows' ? 'claude.exe' : 'claude')
    await this.download(binary, bin)
    if (this.deps.os !== 'windows') chmodSync(bin, 0o755)
    this.remember('claude', binDir)
    return bin
  }

  // The CLI's own sign-in, as the person would start it in a terminal: it opens the browser and
  // waits for the page to call back. Its output only gives the page's address, for a "open it again".
  private async login(engine: SetupEngine, bin: string): Promise<void> {
    const args = engine === 'codex' ? ['login'] : ['auth', 'login']
    const p = this.deps.spawn(bin, args, this.deps.env(engine))
    this.child = p
    let text = ''
    p.output((chunk) => {
      text = (text + chunk).slice(-8_000)
      const url = loginUrl(text)
      if (url && this.current && this.current.url !== url) this.set({ ...this.current, url })
    })
    const late = setTimeout(() => p.kill(), this.deps.timeoutMs ?? 10 * 60_000)
    try {
      const code = await p.exit
      if (code !== 0 && this.current?.state === 'running') {
        const last = text.trim().split('\n').slice(-2).join(' ').trim()
        throw new Error(last ? L(`O login não deu certo: ${last}`, `The sign-in didn't work: ${last}`) : L('O login não deu certo.', "The sign-in didn't work."))
      }
    } finally {
      clearTimeout(late)
      this.child = undefined
    }
  }
}
