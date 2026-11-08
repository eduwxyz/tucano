// The wiki's folder kept in a git repository: a cloud or server Tucano and the person's Obsidian
// vault (with Obsidian Git on their Mac) share one source of truth. Tucano gets a deploy key of its
// own (ed25519, made here, kept sealed in the secrets), clones the repository into the wiki's
// folder, pulls on start, every 2 minutes and before the curator writes, and commits and pushes a
// few seconds after a page is saved.
//
// What never reaches the repository: the pages held for someone (the heritage of team mode), the
// sources that came from a DM, Tucano's own índice.md and registro.md (they name every page), and
// files over 50 MB. They're kept out by the path filter every commit goes through, and listed in
// .git/info/exclude so `git status` leaves them be.
//
// A conflict never overwrites what came from the repository: the remote's version stays in place,
// Tucano's is written next to it as "<name> (versão do Tucano).md", committed, and shown in Cuidados.
// A key that can only read turns the wiki read-only: it shows the repository and takes no writes.
import { execFile } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { L } from '../shared/lang'
import type { WikiGitError, WikiGitHost, WikiGitSetup, WikiGitStatus, WikiGitTest } from '../shared/types'

export const MAX_GIT_FILE = 50 * 1024 * 1024
export const KEY_SECRET = 'wikiGit.key'
const PULL_EVERY = 2 * 60_000
const PUSH_AFTER = 4_000
const BACKOFF = [15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000]
const AUTHOR = { name: 'Tucano', email: 'tucano@users.noreply' }
export const COPY_SUFFIX = (): string => L(' (versão do Tucano)', ' (Tucano’s version)')

// ---------- the address ----------

export interface RepoAddress {
  sshUrl: string
  host: string
  path: string // owner/repo, without .git
  converted?: boolean
  provider?: WikiGitHost
  deployKeyUrl?: string
}

const providerOf = (host: string): WikiGitHost | undefined =>
  host === 'github.com' ? 'github' : host === 'gitlab.com' || /(^|\.)gitlab\./.test(host) ? 'gitlab' : host === 'bitbucket.org' ? 'bitbucket' : host === 'codeberg.org' || /(^|\.)(gitea|forgejo)\./.test(host) ? 'gitea' : undefined

// The page that adds a deploy key, per host.
export function deployKeyPage(provider: WikiGitHost | undefined, host: string, path: string): string | undefined {
  if (provider === 'github') return `https://github.com/${path}/settings/keys/new`
  if (provider === 'gitlab') return `https://${host}/${path}/-/settings/repository#js-deploy-keys-settings`
  if (provider === 'bitbucket') return `https://bitbucket.org/${path}/admin/access-keys/`
  if (provider === 'gitea') return `https://${host}/${path}/settings/keys`
  return undefined
}

// git@host:owner/repo.git, ssh://git@host/owner/repo.git, or an https address (turned into the SSH
// one: the deploy key works over SSH). `local`: file:// and plain paths too (tests, the fake mode).
export function parseRepoUrl(raw: string, local = false): RepoAddress {
  const url = raw.trim()
  const bad = (): never => {
    throw new Error(L('Esse endereço não parece de um repositório git. Use o endereço SSH, como git@github.com:voce/wiki.git.', "That doesn't look like a git repository's address. Use the SSH one, like git@github.com:you/wiki.git."))
  }
  if (!url || /\s/.test(url) || url.length > 500) bad()
  if (local && (url.startsWith('file://') || url.startsWith('/'))) return { sshUrl: url, host: 'local', path: url.replace(/^file:\/\//, '').replace(/\.git$/, '') }
  let host = ''
  let path = ''
  let converted = false
  let port = ''
  const scp = /^([A-Za-z0-9][A-Za-z0-9._-]*)@([A-Za-z0-9][A-Za-z0-9.-]*):(?!\/\/)([^\s]+)$/.exec(url)
  const ssh = /^ssh:\/\/(?:([A-Za-z0-9][A-Za-z0-9._-]*)@)?([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d+))?\/([^\s]+)$/.exec(url)
  const https = /^https?:\/\/(?:[^@/\s]+@)?([A-Za-z0-9][A-Za-z0-9.-]*)(?::\d+)?\/([^\s?#]+)/.exec(url)
  if (scp) ((host = scp[2]!), (path = scp[3]!))
  else if (ssh) ((host = ssh[2]!), (path = ssh[4]!), (port = ssh[3] ?? ''))
  else if (https) ((host = https[1]!), (path = https[2]!), (converted = true))
  else bad()
  path = path.replace(/\/+$/, '').replace(/\.git$/, '')
  // GitHub's page for a file or a tree is still the repository's address
  if (converted && host === 'github.com') path = path.split('/').slice(0, 2).join('/')
  if (converted) path = path.replace(/\/-\/.*$/, '').replace(/\/(src|tree|blob)\/.*$/, '')
  if (!/^[A-Za-z0-9_~][A-Za-z0-9._~-]*(\/[A-Za-z0-9_~][A-Za-z0-9._~-]*)+$/.test(path) || !host.includes('.')) bad()
  const user = scp?.[1] ?? ssh?.[1] ?? 'git'
  const sshUrl = port ? `ssh://${user}@${host}:${port}/${path}.git` : `${user}@${host}:${path}.git`
  const provider = providerOf(host.toLowerCase())
  const deployKeyUrl = deployKeyPage(provider, host, path)
  return { sshUrl, host, path, ...(converted ? { converted } : {}), ...(provider ? { provider } : {}), ...(deployKeyUrl ? { deployKeyUrl } : {}) }
}

// ---------- the key ----------

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
const sshString = (b: Buffer | string): Buffer => {
  const buf = typeof b === 'string' ? Buffer.from(b) : b
  return Buffer.concat([u32(buf.length), buf])
}

// An ed25519 key pair in OpenSSH's own formats (no ssh-keygen needed: Windows and slim servers
// may not have it): the private key as `ssh -i` reads it, the public one as a deploy key line.
export function makeKeyPair(comment = 'tucano-wiki'): { privateKey: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url')
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)])
  const check = randomBytes(4)
  let priv = Buffer.concat([check, check, sshString('ssh-ed25519'), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(comment)])
  const pad: number[] = []
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i)
  priv = Buffer.concat([priv, Buffer.from(pad)])
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0'), sshString('none'), sshString('none'), sshString(''), u32(1), sshString(blob), sshString(priv)])
  const b64 = body.toString('base64').replace(/.{1,70}/g, '$&\n')
  return { privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}-----END OPENSSH PRIVATE KEY-----\n`, publicKey: `ssh-ed25519 ${blob.toString('base64')} ${comment}` }
}

// Whatever git or ssh says goes through this before anyone sees it: no key, no key file's path.
export function redact(text: string, secrets: string[] = []): string {
  let out = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[key]')
  for (const s of secrets) {
    if (!s) continue
    out = out.split(s).join('[key]')
    // the key's body, line by line, should a part of it come out alone
    for (const line of s.split('\n')) if (line.length >= 20) out = out.split(line).join('[key]')
  }
  return out.replace(/[^\s'"]*tucano-key-[A-Za-z0-9]+[^\s'"]*/g, '[key]')
}

// ---------- what git says, in words ----------

const readOnlyText = /marked as read only|read-only|read only|does not have write access|write access to repository not granted|not (?:allowed|authorized|permitted) to (?:push|write)|permission to \S+ denied|is not authorized to push|access denied for deploy key/i

export function classify(text: string, host: string): WikiGitError {
  const where = host && host !== 'local' ? host : L('o servidor do git', 'the git server')
  if (/host key verification failed|remote host identification has changed/i.test(text))
    return { kind: 'hostkey', message: L(`A identidade de ${where} não é a que o Tucano conhecia. Pode ser um ataque, ou o servidor trocou de chave. Confira com quem cuida dele antes de continuar.`, `${where}'s identity isn't the one Tucano knew. It may be an attack, or the server changed its key. Check with whoever runs it before going on.`) }
  if (/permission denied \(publickey|publickey|authentication failed|access denied|invalid credentials|key is not authorized/i.test(text))
    return { kind: 'auth', message: L(`${where} recusou a chave do Tucano. Confira se ela está nas chaves de deploy do repositório. Se a chave foi apagada ou revogada, adicione de novo (ou desconecte e conecte de novo, pra gerar outra).`, `${where} refused Tucano's key. Check that it's in the repository's deploy keys. If the key was deleted or revoked, add it again (or disconnect and connect again, to make another).`) }
  if (/repository not found|does not appear to be a git repository|project you were looking for could not be found|no such file or directory|does not exist/i.test(text))
    return { kind: 'notfound', message: L(`${where} não achou esse repositório. Confira o endereço e se a chave foi adicionada nele: sem a chave, o GitHub diz que o repositório não existe.`, `${where} didn't find that repository. Check the address, and that the key was added to it: without the key, GitHub says the repository doesn't exist.`) }
  if (/could not resolve|connection timed out|operation timed out|network is unreachable|connection refused|no route to host|connection reset|connection closed|temporary failure|timed out|unable to access/i.test(text))
    return { kind: 'network', message: L(`Não consegui falar com ${where}. Confira a internet daqui; o Tucano tenta de novo sozinho.`, `Couldn't reach ${where}. Check the internet here; Tucano tries again on its own.`) }
  const line = text.split('\n').map((l) => l.replace(/^(fatal|error|remote): */i, '').trim()).find((l) => l && !/^hint:/i.test(l)) ?? ''
  return { kind: 'other', message: L(`O git não conseguiu: ${line || 'erro sem mensagem'}`, `git couldn't do it: ${line || 'no message'}`) }
}

export const isReadOnly = (text: string): boolean => readOnlyText.test(text) && !/permission denied \(publickey/i.test(text)

export const noGit = (): WikiGitError => ({
  kind: 'nogit',
  message: L(
    'O git não está instalado neste computador. No Mac, rode xcode-select --install no Terminal; no Windows, instale o Git for Windows (git-scm.com); no Linux, sudo apt install git (ou o do seu sistema). Depois, Sincronizar agora.',
    "git isn't installed on this computer. On a Mac, run xcode-select --install in Terminal; on Windows, install Git for Windows (git-scm.com); on Linux, sudo apt install git (or your system's). Then Sync now."
  )
})

export class GitFailure extends Error {
  constructor(readonly error: WikiGitError) {
    super(error.message)
    this.name = 'GitFailure'
  }
}

// ---------- the sync ----------

interface Config {
  sshUrl: string
  host: string
  path: string
  provider?: WikiGitHost
  deployKeyUrl?: string
  converted?: boolean
  dir?: string // the clone, once connected: the wiki's folder
  incoming?: string // the test's clone, waiting to be connected
  test?: WikiGitTest
  branch?: string
  readOnly?: boolean
  lastSync?: number
  skipped?: { path: string; mb: number }[]
}

export interface WikiGitDeps {
  dataDir: string
  secrets: { get(key: string): Promise<string | undefined>; set(key: string, value: string | undefined): Promise<void> }
  load: () => string | undefined // the config, as JSON (the core's meta)
  store: (json: string | undefined) => void
  // Repository paths (with /) that are never committed, as of now: held pages, DM sources, Tucano's own files.
  privatePaths: () => Set<string>
  // A private file git had to move aside (a new file from the repository took its path): it stays private.
  movedPrivate?: (from: string, to: string) => void
  quiet: (on: boolean) => void // the wiki's watcher waits while git works
  refresh: () => Promise<void> // the folder read again after a pull
  notice: (n: { key: string; pages: string[]; text: string }) => void // in Cuidados
  changed: () => void // the status changed
  currentPages: () => number
  git?: string // the git binary (TUCANO_GIT, else the one on the PATH)
  ssh?: string // what GIT_SSH_COMMAND runs (tests put a stand-in here)
  local?: boolean // file:// addresses (tests, the fake mode)
  pullEvery?: number
  pushAfter?: number
  log?: (line: string) => void
}

type Run = { code: number; out: string; err: string; buf?: Buffer }

const titleOfPath = (p: string): string => p.split('/').pop()!.replace(/\.md$/i, '')
const COUNT_SKIP = new Set(['.git', '.obsidian', '.trash', 'node_modules'])

export class WikiGit {
  private cfg: Config | undefined
  private busy: Promise<unknown> = Promise.resolve()
  private running = false
  private error: WikiGitError | undefined
  private failures = 0
  private nextTry: number | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private pushTimer: ReturnType<typeof setTimeout> | undefined
  private queued = new Map<string, Set<string>>() // title → who wrote it, for the next commit's message
  private gitOk: boolean | undefined
  private key: { privateKey: string; publicKey: string } | undefined
  private stopped = false

  constructor(private deps: WikiGitDeps) {
    try {
      this.cfg = deps.load() ? (JSON.parse(deps.load()!) as Config) : undefined
    } catch {
      this.cfg = undefined
    }
  }

  get connected(): boolean {
    return !!this.cfg?.dir
  }
  get dir(): string | undefined {
    return this.cfg?.dir
  }
  get readOnly(): boolean {
    return !!this.cfg?.dir && !!this.cfg.readOnly
  }
  readOnlyReason(): string | undefined {
    return this.readOnly ? L('A wiki está só leitura: a chave do Tucano não pode escrever no repositório. Em Ajustes da wiki › A pasta, veja como liberar a escrita.', "The wiki is read-only: Tucano's key can't write to the repository. In Wiki settings › The folder, see how to allow writing.") : undefined
  }

  private save(): void {
    this.deps.store(this.cfg ? JSON.stringify(this.cfg) : undefined)
    this.deps.changed()
  }

  status(): WikiGitStatus {
    const c = this.cfg
    const setup: WikiGitSetup | undefined = c && this.key ? { sshUrl: c.sshUrl, host: c.host, publicKey: this.key.publicKey, ...(c.converted ? { converted: true } : {}), ...(c.provider ? { provider: c.provider } : {}), ...(c.deployKeyUrl ? { deployKeyUrl: c.deployKeyUrl } : {}) } : undefined
    const state: WikiGitStatus['state'] = !c ? 'off' : !c.dir ? 'setup' : this.running ? 'syncing' : this.error ? 'error' : 'ok'
    return {
      state,
      ...(setup ? { setup } : {}),
      ...(c?.test && !c.dir ? { test: c.test } : {}),
      ...(c?.branch ? { branch: c.branch } : {}),
      readOnly: this.readOnly,
      ...(c?.lastSync ? { lastSync: c.lastSync } : {}),
      ...(this.error && this.nextTry ? { nextTry: this.nextTry } : {}),
      ...(this.error ? { error: this.error } : {}),
      skipped: c?.skipped ?? [],
      git: this.gitOk !== false
    }
  }

  // The key, from the secrets (once per run of the app).
  async loadKey(): Promise<void> {
    if (this.key || !this.cfg) return
    const v = await this.deps.secrets.get(KEY_SECRET).catch(() => undefined)
    if (v) this.key = JSON.parse(v) as { privateKey: string; publicKey: string }
  }

  // Step 1: the address. The key is made once and kept for this wiki; a new address keeps it.
  async setup(url: string): Promise<WikiGitSetup> {
    if (this.connected) throw new Error(L('A wiki já sincroniza com um repositório. Desconecte antes de trocar.', 'The wiki already syncs with a repository. Disconnect before changing it.'))
    const a = parseRepoUrl(url, this.deps.local)
    await this.loadKey()
    if (!this.key) {
      this.key = makeKeyPair(`tucano-wiki@${a.host}`)
      await this.deps.secrets.set(KEY_SECRET, JSON.stringify(this.key))
    }
    this.dropIncoming()
    this.cfg = { sshUrl: a.sshUrl, host: a.host, path: a.path, ...(a.provider ? { provider: a.provider } : {}), ...(a.deployKeyUrl ? { deployKeyUrl: a.deployKeyUrl } : {}), ...(a.converted ? { converted: true } : {}) }
    this.error = undefined
    this.save()
    return this.status().setup!
  }

  private dropIncoming(): void {
    if (this.cfg?.incoming) rmSync(this.cfg.incoming, { recursive: true, force: true })
  }

  // ---------- running git ----------

  private gitBin(): string {
    return this.deps.git ?? process.env['TUCANO_GIT'] ?? 'git'
  }

  private async hasGit(): Promise<boolean> {
    if (this.gitOk) return true
    const r = await this.exec(['--version'], {})
    this.gitOk = r.code === 0 && /git version/.test(r.out)
    return this.gitOk
  }

  private exec(args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; buffer?: boolean; timeout?: number }): Promise<Run> {
    return new Promise((resolve) => {
      const child = execFile(
        this.gitBin(),
        args,
        {
          cwd: o.cwd,
          env: { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', ...o.env },
          encoding: o.buffer ? 'buffer' : 'utf8',
          maxBuffer: 200 * 1024 * 1024,
          timeout: o.timeout ?? 120_000,
          windowsHide: true
        },
        (e, stdout, stderr) => {
          const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? ((e as { code: number }).code) : -1) : 0
          const missing = (e as NodeJS.ErrnoException | null)?.code === 'ENOENT'
          resolve({ code, out: o.buffer ? '' : String(stdout), err: missing ? 'git: not found' : String(stderr), ...(o.buffer ? { buf: stdout as unknown as Buffer } : {}) })
        }
      )
      if (o.input !== undefined) child.stdin?.end(o.input)
    })
  }

  // The key on disk only while git needs it: a file of its own (0600) in a folder of its own, gone right after.
  private async withKey<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    await this.loadKey()
    if (!this.key) throw new GitFailure({ kind: 'auth', message: L('A chave do Tucano pra esse repositório sumiu. Desconecte e conecte de novo pra gerar outra.', "Tucano's key for this repository is gone. Disconnect and connect again to make another.") })
    const folder = mkdtempSync(join(tmpdir(), 'tucano-key-'))
    const file = join(folder, 'id_ed25519')
    try {
      writeFileSync(file, this.key.privateKey, { mode: 0o600 })
      chmodSync(file, 0o600)
      const known = join(this.deps.dataDir, 'ssh', 'known_hosts')
      mkdirSync(dirname(known), { recursive: true })
      const q = (p: string): string => `"${p.split('\\').join('/')}"`
      const ssh = `${q(this.deps.ssh ?? 'ssh')} -i ${q(file)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${q(known)} -o BatchMode=yes -o ConnectTimeout=20`
      return await fn({ GIT_SSH_COMMAND: ssh, GIT_SSH_VARIANT: 'ssh' })
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }

  private secretsOut(): string[] {
    return this.key ? [this.key.privateKey] : []
  }

  // A git command that has to work: its failure becomes words, with nothing of the key in them.
  private async must(args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number } = {}): Promise<string> {
    const r = await this.exec(args, o)
    if (r.code !== 0) throw this.failure(r)
    return r.out
  }
  private failure(r: Run): GitFailure {
    const text = redact(`${r.err}\n${r.out}`, this.secretsOut())
    if (/git: not found/.test(text)) return (this.gitOk = false), new GitFailure(noGit())
    return new GitFailure(classify(text, this.cfg?.host ?? ''))
  }

  // ---------- step 2: test ----------

  // ls-remote with the key, then a clone apart (the wiki doesn't change until Connect).
  test(): Promise<WikiGitTest> {
    return this.serial(async () => {
      const c = this.need()
      if (c.dir) throw new Error(L('Já está conectado.', "It's already connected."))
      if (!(await this.hasGit())) throw new GitFailure(noGit())
      try {
        const t = await this.withKey(async (env) => {
          const head = await this.must(['ls-remote', '--symref', c.sshUrl, 'HEAD'], { env, timeout: 60_000 })
          const branch = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(head)?.[1] ?? 'main'
          this.dropIncoming()
          const incoming = join(this.deps.dataDir, `wiki-repo.incoming-${randomBytes(3).toString('hex')}`)
          await this.must(['-c', 'core.autocrlf=false', 'clone', '--quiet', c.sshUrl, incoming], { env, timeout: 600_000 })
          c.incoming = incoming
          const count = this.count(incoming)
          return { branch, empty: !head.trim(), ...count, currentPages: this.deps.currentPages() }
        })
        c.test = t
        c.branch = t.branch
        this.error = undefined
        this.save()
        return t
      } catch (e) {
        this.dropIncoming()
        delete c.incoming
        this.save()
        throw e
      }
    })
  }

  private count(dir: string): { pages: number; pdfs: number; docx: number } {
    const n = { pages: 0, pdfs: 0, docx: 0 }
    const go = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (COUNT_SKIP.has(e.name) || e.name.startsWith('.')) continue
        if (e.isDirectory()) go(join(d, e.name))
        else {
          const x = extname(e.name).toLowerCase()
          if (x === '.md') n.pages++
          else if (x === '.pdf') n.pdfs++
          else if (x === '.docx') n.docx++
        }
      }
    }
    go(dir)
    return n
  }

  private need(): Config {
    if (!this.cfg) throw new Error(L('Primeiro cole o endereço do repositório.', "First paste the repository's address."))
    return this.cfg
  }

  // ---------- step 3: connect ----------

  // The tested clone becomes the wiki's folder (a new one, in the app's data: the folder the wiki
  // had stays as it was). Returns it; the core points the wiki there and merges if asked.
  adopt(): Promise<string> {
    return this.serial(async () => {
      const c = this.need()
      if (c.dir) return c.dir
      if (!c.incoming || !existsSync(join(c.incoming, '.git'))) throw new Error(L('Teste a conexão primeiro.', 'Test the connection first.'))
      let dir = join(this.deps.dataDir, 'wiki-repo')
      for (let k = 2; existsSync(dir); k++) dir = join(this.deps.dataDir, `wiki-repo-${k}`)
      renameSync(c.incoming, dir)
      delete c.incoming
      const branch = c.branch ?? 'main'
      for (const [k, v] of [['core.autocrlf', 'false'], ['core.quotepath', 'false'], ['core.precomposeunicode', 'true'], ['commit.gpgsign', 'false'], ['pull.rebase', 'true']] as const) await this.must(['config', k, v], { cwd: dir })
      // an empty repository: the first commit goes on its default branch
      if ((await this.exec(['rev-parse', '--verify', 'HEAD'], { cwd: dir })).code !== 0) await this.must(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: dir })
      c.dir = dir
      c.readOnly = false
      delete c.test
      this.save()
      return dir
    })
  }

  // Stops syncing and forgets the key; the folder stays as it is (plain Markdown, still a clone).
  async disconnect(): Promise<void> {
    await this.busy.catch(() => {})
    this.stop()
    this.dropIncoming()
    this.cfg = undefined
    this.key = undefined
    this.error = undefined
    this.failures = 0
    this.queued.clear()
    await this.deps.secrets.set(KEY_SECRET, undefined)
    this.stopped = false
    this.save()
  }

  // ---------- the loop ----------

  // `now`: a round right away (at the app's start); else the loop goes on from the next round.
  start(now = true): void {
    this.stopped = false
    if (this.connected && now) this.schedule(0)
  }
  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.timer = this.pushTimer = undefined
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.stopped || !this.connected) return
    this.timer = setTimeout(() => void this.sync().catch(() => {}), ms)
    this.timer.unref?.()
  }

  // A page was written here: committed and pushed a few seconds later, with whoever wrote it.
  wrote(title: string, who: string): void {
    if (!this.connected || this.readOnly) return
    const by = this.queued.get(title) ?? new Set<string>()
    if (who) by.add(who)
    this.queued.set(title, by)
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => void this.sync().catch(() => {}), this.deps.pushAfter ?? PUSH_AFTER)
    this.pushTimer.unref?.()
  }

  // Before the curator writes: what the repository has now.
  pull(): Promise<void> {
    return this.connected ? this.sync().then(() => {}) : Promise.resolve()
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn)
    this.busy = run.catch(() => {})
    return run
  }

  // One round: commit what changed here, fetch, rebase on the repository, push. Never two at once.
  // `message`: the commit's, instead of the one made from what was written (a merge says so).
  sync(o: { write?: boolean; message?: string; who?: string } = {}): Promise<WikiGitStatus> {
    return this.serial(async () => {
      const c = this.cfg
      if (!c?.dir) return this.status()
      if (this.pushTimer) clearTimeout(this.pushTimer)
      this.pushTimer = undefined
      if (o.write && c.readOnly) ((c.readOnly = false), this.save())
      this.running = true
      this.deps.changed()
      this.deps.quiet(true)
      try {
        if (!(await this.hasGit())) throw new GitFailure(noGit())
        await this.withKey((env) => this.round(c, env, o))
        c.lastSync = Date.now()
        this.error = undefined
        this.failures = 0
        this.nextTry = undefined
        this.save()
        this.schedule(this.deps.pullEvery ?? PULL_EVERY)
      } catch (e) {
        this.error = e instanceof GitFailure ? e.error : { kind: 'other', message: redact(e instanceof Error ? e.message : String(e), this.secretsOut()) }
        const wait = BACKOFF[Math.min(this.failures, BACKOFF.length - 1)]!
        this.failures++
        this.nextTry = Date.now() + wait
        this.deps.log?.(`[wiki-git] ${this.error.kind}: ${this.error.message}`)
        this.schedule(wait)
      } finally {
        this.running = false
        this.deps.quiet(false)
        await this.deps.refresh().catch(() => {})
        this.deps.changed()
      }
      return this.status()
    })
  }

  private async round(c: Config, env: NodeJS.ProcessEnv, o: { message?: string; who?: string }): Promise<void> {
    const dir = c.dir!
    const branch = c.branch ?? 'main'
    this.writeExclude(dir)
    if (c.readOnly) {
      // The repository is the truth here: what it has, as it has it.
      await this.must(['fetch', '--quiet', 'origin'], { cwd: dir, env })
      if (!(await this.has(dir, `refs/remotes/origin/${branch}`))) return
      if (!(await this.has(dir, 'HEAD'))) return this.checkoutRemote(dir, branch)
      let r = await this.exec(['merge', '--quiet', '--ff-only', `origin/${branch}`], { cwd: dir })
      // a file kept only here (written before it turned read-only) where the repository brings one: it steps aside
      const blocked = r.code ? this.blockedPaths(r.err) : []
      if (blocked.length) (blocked.forEach((p) => this.moveAside(dir, p)), (r = await this.exec(['merge', '--quiet', '--ff-only', `origin/${branch}`], { cwd: dir })))
      if (r.code) await this.must(['reset', '--quiet', '--hard', `origin/${branch}`], { cwd: dir })
      return
    }
    await this.commitLocal(dir, o)
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.must(['fetch', '--quiet', 'origin'], { cwd: dir, env })
      const remote = await this.has(dir, `refs/remotes/origin/${branch}`)
      const local = await this.has(dir, 'HEAD')
      if (remote && !local) {
        // nothing committed here yet: the repository's history, as is (untracked files stay)
        await this.checkoutRemote(dir, branch)
        continue
      }
      if (remote) await this.rebase(dir, branch)
      if (!local && !(await this.has(dir, 'HEAD'))) return
      const ahead = remote ? Number((await this.must(['rev-list', '--count', `origin/${branch}..HEAD`], { cwd: dir })).trim()) : 1
      if (!ahead) return
      const r = await this.exec(['push', '--porcelain', 'origin', `HEAD:refs/heads/${branch}`], { cwd: dir, env, timeout: 300_000 })
      if (r.code === 0) return
      const text = redact(`${r.err}\n${r.out}`, this.secretsOut())
      if (isReadOnly(text)) return this.enterReadOnly(c, env)
      if (/\[rejected\]|non-fast-forward|fetch first|stale info/i.test(text)) continue // someone pushed meanwhile: again
      throw new GitFailure(classify(text, c.host))
    }
  }

  private async has(dir: string, ref: string): Promise<boolean> {
    return (await this.exec(['rev-parse', '--verify', '--quiet', ref], { cwd: dir })).code === 0
  }

  private async checkoutRemote(dir: string, branch: string): Promise<void> {
    const r = await this.exec(['checkout', '--quiet', '-B', branch, `origin/${branch}`], { cwd: dir })
    if (r.code === 0) return
    // a file here in the way of one from the repository: it steps aside, the repository's goes in
    const blocked = this.blockedPaths(r.err)
    if (!blocked.length) throw this.failure(r)
    for (const p of blocked) this.moveAside(dir, p)
    await this.must(['checkout', '--quiet', '-B', branch, `origin/${branch}`], { cwd: dir })
  }

  // ---------- what goes in a commit ----------

  // .git/info/exclude: the private files, so `git status` leaves them be (the path filter below is what keeps them out).
  private writeExclude(dir: string): void {
    const esc = (p: string): string => '/' + p.replace(/[\\*?[\]!#]/g, '\\$&').replace(/^ /, '\\ ').replace(/ $/, '\\ ')
    const lines = [...this.deps.privatePaths()].sort().map(esc)
    const big = (this.cfg?.skipped ?? []).map((s) => esc(s.path))
    const text = `# Kept by Tucano: held pages, DM sources, its own files, and files over 50 MB never go to the repository.\n${[...lines, ...big].join('\n')}\n`
    const file = join(dir, '.git', 'info', 'exclude')
    mkdirSync(dirname(file), { recursive: true })
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeFileSync(file, text)
  }

  // What changed in the folder, as git sees it (paths with /, NFC).
  private async changes(dir: string): Promise<string[]> {
    const out = await this.must(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { cwd: dir })
    const paths: string[] = []
    for (const entry of out.split('\0')) if (entry.length > 3) paths.push(entry.slice(3).normalize('NFC'))
    return paths
  }

  // Commits what changed here and may go: never a private path, never a file over 50 MB.
  private async commitLocal(dir: string, o: { message?: string; who?: string }): Promise<boolean> {
    const priv = new Set([...this.deps.privatePaths()].map((p) => p.normalize('NFC')))
    const all = await this.changes(dir)
    const skipped: { path: string; mb: number }[] = []
    const go: string[] = []
    for (const p of all) {
      if (priv.has(p)) continue
      let size = 0
      try {
        size = statSync(join(dir, p)).size
      } catch {
        // deleted: goes as a deletion
      }
      if (size > MAX_GIT_FILE) skipped.push({ path: p, mb: Math.round(size / 1024 / 1024) })
      else go.push(p)
    }
    const c = this.cfg!
    const before = JSON.stringify(c.skipped ?? [])
    const known = new Set((c.skipped ?? []).map((s) => s.path))
    c.skipped = skipped
    if (JSON.stringify(skipped) !== before) {
      this.save()
      for (const s of skipped.filter((x) => !known.has(x.path)))
        this.deps.notice({ key: `git-big:${s.path}`, pages: [], text: L(`**${s.path}** tem ${s.mb} MB e não foi pro repositório: o git só leva arquivos de até 50 MB. Ele continua aqui, na pasta da wiki.`, `**${s.path}** is ${s.mb} MB and didn't go to the repository: git takes files up to 50 MB only. It stays here, in the wiki's folder.`) })
      this.writeExclude(dir)
    }
    if (!go.length) return false
    await this.must(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: dir, input: go.join('\0') + '\0', env: { GIT_LITERAL_PATHSPECS: '1' } })
    if ((await this.exec(['diff', '--cached', '--quiet'], { cwd: dir })).code === 0) return false
    const { message, who } = this.message(go, o)
    const name = who ?? AUTHOR.name
    await this.must(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', message], { cwd: dir, env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email } })
    this.queued.clear()
    return true
  }

  // "Tucano: <page title> (<who>)": the pages written here since the last commit, or the files.
  // Only what's in this commit: a page written in the same round but kept out (held, a DM source)
  // isn't named, nor whoever wrote only that.
  private message(paths: string[], o: { message?: string; who?: string }): { message: string; who?: string } {
    if (o.message) return { message: o.message, ...(o.who ? { who: o.who } : {}) }
    const key = (t: string): string => t.normalize('NFC').toLowerCase()
    const inCommit = new Set(paths.filter((p) => p.toLowerCase().endsWith('.md')).map((p) => key(titleOfPath(p))))
    const queued = [...this.queued].filter(([t]) => inCommit.has(key(t)))
    const titles = queued.length ? queued.map(([t]) => t) : [...new Set(paths.filter((p) => p.endsWith('.md')).map(titleOfPath))]
    const people = [...new Set(queued.flatMap(([, s]) => [...s]))]
    const what = titles.length === 0 ? (paths.length === 1 ? titleOfPath(paths[0]!) : L(`${paths.length} arquivos`, `${paths.length} files`)) : titles.length <= 3 ? titles.join(', ') : L(`${titles.slice(0, 2).join(', ')} e mais ${titles.length - 2}`, `${titles.slice(0, 2).join(', ')} and ${titles.length - 2} more`)
    const who = (queued.length && people.join(', ')) || AUTHOR.name
    return { message: `Tucano: ${what} (${who})`, ...(people.length === 1 ? { who: people[0]! } : {}) }
  }

  // ---------- conflicts ----------

  // "<name> (versão do Tucano).md", or with a number when that's taken too.
  private copyName(dir: string, path: string): string {
    const ext = extname(path)
    const base = path.slice(0, path.length - ext.length)
    let out = `${base}${COPY_SUFFIX()}${ext}`
    for (let k = 2; existsSync(join(dir, out)); k++) out = `${base}${COPY_SUFFIX().replace(/\)$/, ` ${k})`)}${ext}`
    return out
  }

  private blockedPaths(err: string): string[] {
    const m = /would be overwritten by (?:checkout|merge)[^\n]*:\n([\s\S]*?)\n(?:Please|Aborting)/i.exec(err)
    return m ? m[1]!.split('\n').map((l) => l.trim()).filter(Boolean) : []
  }

  // A file here (untracked, private or Tucano's own) where the repository brings one: it moves to its copy name.
  private moveAside(dir: string, path: string): void {
    const to = this.copyName(dir, path)
    renameSync(join(dir, path), join(dir, to))
    if (this.deps.privatePaths().has(path)) this.deps.movedPrivate?.(path, to)
  }

  private async rebase(dir: string, branch: string): Promise<void> {
    if (!(await this.has(dir, 'HEAD'))) return
    const base = (await this.must(['merge-base', 'HEAD', `origin/${branch}`], { cwd: dir }).catch(() => '')).trim()
    const theirs = (await this.must(['rev-parse', `origin/${branch}`], { cwd: dir })).trim()
    if (base === theirs) return // nothing new there
    // Tracked files changed here that don't go (a held page that was in the repository before it was
    // held, a file grown past 50 MB): put aside while git works, back as they were after.
    const kept = new Map<string, Buffer>()
    for (const p of await this.changes(dir)) {
      if (!(await this.tracked(dir, p))) continue
      if (existsSync(join(dir, p))) kept.set(p, readFileSync(join(dir, p)))
      await this.must(['checkout', '--quiet', '--', p], { cwd: dir, env: { GIT_LITERAL_PATHSPECS: '1' } })
    }
    const conflicts: { path: string; copy?: string }[] = []
    try {
      let r = await this.exec(['-c', 'core.editor=true', 'rebase', '--quiet', `origin/${branch}`], { cwd: dir })
      for (let turn = 0; r.code !== 0; turn++) {
        if (turn > 200) throw this.failure(r)
        const blocked = this.blockedPaths(r.err)
        if (blocked.length) {
          for (const p of blocked) this.moveAside(dir, p)
          r = this.rebasing(dir) ? await this.exec(['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: dir }) : await this.exec(['-c', 'core.editor=true', 'rebase', '--quiet', `origin/${branch}`], { cwd: dir })
          continue
        }
        if (!this.rebasing(dir)) throw this.failure(r)
        const files = (await this.must(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: dir })).split('\0').filter(Boolean)
        if (!files.length && /nothing to commit|no changes|empty/i.test(r.out + r.err)) {
          // the commit being replayed has nothing left once settled: it goes
          r = await this.exec(['rebase', '--skip'], { cwd: dir })
          continue
        }
        if (!files.length) throw this.failure(r)
        for (const f of files) conflicts.push(await this.settle(dir, f))
        r = await this.exec(['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: dir })
      }
    } catch (e) {
      if (this.rebasing(dir)) await this.exec(['rebase', '--abort'], { cwd: dir })
      throw e
    } finally {
      for (const [p, buf] of kept) (mkdirSync(dirname(join(dir, p)), { recursive: true }), writeFileSync(join(dir, p), buf))
    }
    for (const c of conflicts) {
      const t = titleOfPath(c.path)
      const page = c.path.endsWith('.md')
      this.deps.notice({
        key: `git-conflict:${c.path}:${Date.now()}`,
        pages: page ? [t, ...(c.copy ? [titleOfPath(c.copy)] : [])] : [],
        text: c.copy
          ? page
            ? L(`[[${t}]] mudou no repositório e aqui ao mesmo tempo. Ficou a versão do repositório; a do Tucano está em [[${titleOfPath(c.copy)}]]. Junte o que valer e apague a cópia.`, `[[${t}]] changed in the repository and here at the same time. The repository's version stayed; Tucano's is in [[${titleOfPath(c.copy)}]]. Merge what's worth it and delete the copy.`)
            : L(`**${c.path}** mudou no repositório e aqui ao mesmo tempo. Ficou o do repositório; o do Tucano está em **${c.copy}**.`, `**${c.path}** changed in the repository and here at the same time. The repository's stayed; Tucano's is in **${c.copy}**.`)
          : L(`**${c.path}** foi apagado aqui e mudou no repositório: ficou o do repositório.`, `**${c.path}** was deleted here and changed in the repository: the repository's stayed.`)
      })
    }
  }

  private rebasing(dir: string): boolean {
    return existsSync(join(dir, '.git', 'rebase-merge')) || existsSync(join(dir, '.git', 'rebase-apply'))
  }
  private async tracked(dir: string, p: string): Promise<boolean> {
    return (await this.exec(['ls-files', '--error-unmatch', '--', p], { cwd: dir, env: { GIT_LITERAL_PATHSPECS: '1' } })).code === 0
  }

  // One conflicted file in a rebase: stage 2 is the repository's side (what's being rebased onto),
  // stage 3 Tucano's commit. The repository's stays in place; Tucano's goes to its copy name.
  private async settle(dir: string, f: string): Promise<{ path: string; copy?: string }> {
    const stage = async (n: 2 | 3): Promise<Buffer | undefined> => {
      const r = await this.exec(['show', `:${n}:${f}`], { cwd: dir, buffer: true })
      return r.code === 0 ? r.buf : undefined
    }
    const remote = await stage(2)
    const mine = await stage(3)
    let copy: string | undefined
    const lit = { GIT_LITERAL_PATHSPECS: '1' }
    if (mine && !(remote && remote.equals(mine))) {
      copy = this.copyName(dir, f)
      mkdirSync(dirname(join(dir, copy)), { recursive: true })
      writeFileSync(join(dir, copy), mine)
      await this.must(['add', '--', copy], { cwd: dir, env: lit })
    }
    if (remote) {
      mkdirSync(dirname(join(dir, f)), { recursive: true })
      writeFileSync(join(dir, f), remote)
      await this.must(['add', '--', f], { cwd: dir, env: lit })
    } else await this.must(['rm', '--quiet', '--force', '--', f], { cwd: dir, env: lit })
    return { path: f, ...(copy ? { copy } : {}) }
  }

  // ---------- read-only ----------

  // The key reads but can't push: the wiki shows the repository from now on and takes no writes.
  // What was written here and couldn't go is never lost: a page new here stays as it is (only here);
  // one the repository has too goes back to the repository's, with Tucano's next to it as "(versão do Tucano)".
  private async enterReadOnly(c: Config, env: NodeJS.ProcessEnv): Promise<void> {
    const dir = c.dir!
    const branch = c.branch ?? 'main'
    await this.must(['fetch', '--quiet', 'origin'], { cwd: dir, env })
    const remote = await this.has(dir, `refs/remotes/origin/${branch}`)
    const kept: string[] = []
    if (remote) {
      const changed = (await this.must(['diff', '--name-only', '-z', '--no-renames', `origin/${branch}`, 'HEAD'], { cwd: dir })).split('\0').filter(Boolean)
      await this.must(['reset', '--quiet', '--mixed', `origin/${branch}`], { cwd: dir }) // the commits go; the files stay
      const lit = { GIT_LITERAL_PATHSPECS: '1' }
      for (const f of changed) {
        if ((await this.exec(['cat-file', '-e', `origin/${branch}:${f}`], { cwd: dir })).code !== 0) {
          if (existsSync(join(dir, f)) && f !== 'esquema.md') kept.push(f) // new here: stays, untracked
          continue
        }
        if (existsSync(join(dir, f))) {
          const to = this.copyName(dir, f)
          writeFileSync(join(dir, to), readFileSync(join(dir, f)))
          kept.push(to)
        }
        await this.must(['checkout', '--quiet', `origin/${branch}`, '--', f], { cwd: dir, env: lit })
      }
    } else {
      // an empty repository that won't take a first commit: the files stay, the commit goes
      await this.exec(['update-ref', '-d', 'HEAD'], { cwd: dir })
      await this.exec(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.'], { cwd: dir })
    }
    c.readOnly = true
    this.queued.clear()
    this.save()
    const pages = kept.filter((p) => p.endsWith('.md')).map(titleOfPath)
    this.deps.notice({
      key: `git-readonly:${Date.now()}`,
      pages,
      text: L(
        `O repositório não aceitou o envio: a chave do Tucano só pode ler. A wiki ficou só leitura e mostra o que está no repositório.${pages.length ? ` O que não foi enviado ficou aqui: ${pages.map((t) => `[[${t}]]`).join(', ')}.` : ''} Pra escrever, marque "Allow write access" na chave e toque em Tentar escrever de novo.`,
        `The repository didn't take the push: Tucano's key can only read. The wiki is read-only now and shows what's in the repository.${pages.length ? ` What didn't go stayed here: ${pages.map((t) => `[[${t}]]`).join(', ')}.` : ''} To write, tick "Allow write access" on the key and click Try writing again.`
      )
    })
  }
}
