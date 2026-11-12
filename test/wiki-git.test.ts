// The wiki's folder kept in a git repository (src/core/wiki-git.ts), against local bare repositories
// (file:// remotes, no network, no GitHub): connect, clone and index; pull; commit and push; a
// conflict; held pages; big files; read-only; a refused key, and the key never in what anyone sees.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { classify, GitFailure, isReadOnly, KEY_SECRET, makeKeyPair, parseRepoUrl, redact, WikiGit } from '../src/core/wiki-git'
import { pageKey, Wiki } from '../src/core/wiki'
import { WikiCurator } from '../src/core/wiki-curator'
import type { Message, Settings } from '../src/shared/types'

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 })

// names byte for byte (an NFD name stays NFD, on a Mac too), and no identity of the machine's needed
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'core.precomposeunicode=false', '-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Eduardo', GIT_AUTHOR_EMAIL: 'e@x', GIT_COMMITTER_NAME: 'Eduardo', GIT_COMMITTER_EMAIL: 'e@x' } })

// A bare repository (the "GitHub") and a clone of it (the person's Obsidian vault on the Mac).
function remote(files: Record<string, string | Buffer> = {}, hook?: string): { bare: string; url: string; mac: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'tucano-git-'))
  const bare = join(root, 'vault.git')
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', bare])
  const mac = join(root, 'mac')
  execFileSync('git', ['-c', 'core.precomposeunicode=false', 'clone', '--quiet', bare, mac], { stdio: 'ignore' })
  git(mac, 'config', 'core.precomposeunicode', 'false')
  git(mac, 'checkout', '--quiet', '-B', 'main')
  if (Object.keys(files).length) {
    for (const [f, text] of Object.entries(files)) (mkdirSync(join(mac, f, '..'), { recursive: true }), writeFileSync(join(mac, f), text))
    git(mac, 'add', '-A')
    git(mac, 'commit', '--quiet', '-m', 'vault')
    git(mac, 'push', '--quiet', 'origin', 'main')
  }
  // The repository's own hooks, even on a machine whose gitconfig points core.hooksPath somewhere
  // else: without this the hook is written and never run, and the push it must refuse goes through.
  if (hook) (writeFileSync(join(bare, 'hooks', 'pre-receive'), hook), chmodSync(join(bare, 'hooks', 'pre-receive'), 0o755), git(bare, 'config', 'core.hooksPath', join(bare, 'hooks')))
  return { bare, url: `file://${bare}`, mac, root }
}
// What the Mac does with Obsidian Git: edit, commit, push.
function macEdit(mac: string, file: string, text: string): void {
  git(mac, 'pull', '--quiet', '--rebase', 'origin', 'main')
  writeFileSync(join(mac, file), text)
  git(mac, 'add', '-A')
  git(mac, 'commit', '--quiet', '-m', `edit ${file}`)
  git(mac, 'push', '--quiet', 'origin', 'main')
}
const inRemote = (bare: string): string[] => git(bare, 'ls-tree', '-r', '--name-only', 'main').split('\n').filter(Boolean)

const memSecrets = (): { get(k: string): Promise<string | undefined>; set(k: string, v: string | undefined): Promise<void>; store: Map<string, string> } => {
  const store = new Map<string, string>()
  return { store, get: async (k) => store.get(k), set: async (k, v) => void (v === undefined ? store.delete(k) : store.set(k, v)) }
}

// A WikiGit wired as the core wires it, to a real Wiki on the clone once connected.
async function connected(url: string, o: { ssh?: string } = {}) {
  const data = mkdtempSync(join(tmpdir(), 'tucano-data-'))
  let meta: string | undefined
  let wiki: Wiki | undefined
  const logs: string[] = []
  const secrets = memSecrets()
  const dms = new Map<string, string | null>([['dm-ana', 'ana'], ['canal', null]])
  const g: WikiGit = new WikiGit({
    dataDir: data,
    secrets,
    load: () => meta,
    store: (j) => void (meta = j),
    privatePaths: () => {
      const out = new Set(['índice.md', 'registro.md', ...(wiki?.heldFiles() ?? [])])
      for (const s of wiki?.sources(1000) ?? []) if (s.origin.conversationId && dms.get(s.origin.conversationId) !== null) out.add(`${s.file}.md`)
      return out
    },
    quiet: (on) => wiki?.quiet(on),
    refresh: () => wiki?.refresh() ?? Promise.resolve(),
    notice: (n) => wiki?.addNotice(n),
    changed: () => {},
    currentPages: () => 0,
    local: true,
    pushAfter: 60_000,
    log: (l) => void logs.push(l),
    ...(o.ssh ? { ssh: o.ssh } : {})
  })
  const setup = await g.setup(url)
  const test = await g.test()
  const dir = await g.adopt()
  wiki = new Wiki({ dir, indexPath: join(data, 'wiki.db'), onWrite: (w) => g.wrote(w.title, w.byName), readOnly: () => g.readOnlyReason(), dmOf: (c) => dms.get(c) })
  wiki.init(false)
  return { g, wiki, dir, data, setup, test, logs, secrets }
}

describe('the deploy key', () => {
  it('is an ed25519 pair in OpenSSH formats that ssh-keygen reads', () => {
    const k = makeKeyPair('tucano-wiki@github.com')
    expect(k.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/=]+ tucano-wiki@github\.com$/)
    expect(k.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+\n-----END OPENSSH PRIVATE KEY-----\n$/)
    let keygen = true
    try {
      execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' })
    } catch (e) {
      keygen = (e as { status?: number }).status !== undefined && (e as NodeJS.ErrnoException).code !== 'ENOENT'
    }
    if (!keygen) return
    const f = join(mkdtempSync(join(tmpdir(), 'tucano-k-')), 'id')
    writeFileSync(f, k.privateKey, { mode: 0o600 })
    expect(execFileSync('ssh-keygen', ['-y', '-f', f], { encoding: 'utf8' }).trim().split(' ').slice(0, 2)).toEqual(k.publicKey.split(' ').slice(0, 2))
  })

  it('never shows in what git or ssh say', () => {
    const k = makeKeyPair()
    const said = `Warning: something\n${k.privateKey}\nfatal: Could not read from remote repository.\nkey at /tmp/tucano-key-abc123/id_ed25519`
    const out = redact(said, [k.privateKey])
    expect(out).not.toContain('OPENSSH PRIVATE KEY')
    for (const line of k.privateKey.split('\n').filter((l) => l.length > 20)) expect(out).not.toContain(line)
    expect(out).not.toContain('tucano-key-abc123')
  })
})

describe('the address', () => {
  it('takes SSH, turns https into SSH, and knows each host’s deploy key page', () => {
    expect(parseRepoUrl('git@github.com:edu/vault.git')).toMatchObject({ sshUrl: 'git@github.com:edu/vault.git', provider: 'github', deployKeyUrl: 'https://github.com/edu/vault/settings/keys/new' })
    expect(parseRepoUrl('https://github.com/edu/vault')).toMatchObject({ sshUrl: 'git@github.com:edu/vault.git', converted: true })
    expect(parseRepoUrl('https://github.com/edu/vault/tree/main/notes').sshUrl).toBe('git@github.com:edu/vault.git')
    expect(parseRepoUrl('https://gitlab.com/time/sub/vault.git')).toMatchObject({ sshUrl: 'git@gitlab.com:time/sub/vault.git', deployKeyUrl: 'https://gitlab.com/time/sub/vault/-/settings/repository#js-deploy-keys-settings' })
    expect(parseRepoUrl('https://edu@bitbucket.org/edu/vault.git')).toMatchObject({ sshUrl: 'git@bitbucket.org:edu/vault.git', deployKeyUrl: 'https://bitbucket.org/edu/vault/admin/access-keys/' })
    expect(parseRepoUrl('git@codeberg.org:edu/vault.git').deployKeyUrl).toBe('https://codeberg.org/edu/vault/settings/keys')
    expect(parseRepoUrl('ssh://git@git.empresa.com:2222/edu/vault.git')).toMatchObject({ sshUrl: 'ssh://git@git.empresa.com:2222/edu/vault.git', host: 'git.empresa.com' })
    expect(parseRepoUrl('git@git.empresa.com:edu/vault.git').deployKeyUrl).toBeUndefined()
    for (const bad of ['', 'zz-nope', 'git@github.com:', 'https://github.com/', 'file:///tmp/x.git', 'ftp://h/x', 'git@github.com:edu/vault.git; rm -rf /', 'git@-oProxyCommand.x:a/b.git', 'ssh://-oProxyCommand=x/a/b', 'git@github.com:-u/x.git', 'git@github.com:edu/../x.git']) expect(() => parseRepoUrl(bad), bad).toThrow()
    expect(parseRepoUrl('file:///tmp/x.git', true).sshUrl).toBe('file:///tmp/x.git')
  })

  it('reads what git says as words', () => {
    expect(classify('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'github.com').kind).toBe('auth')
    expect(classify('ERROR: Repository not found.\nfatal: Could not read from remote repository.', 'github.com').kind).toBe('notfound')
    expect(classify('ssh: Could not resolve hostname github.com: nodename nor servname provided', 'github.com').kind).toBe('network')
    expect(classify('Host key verification failed.', 'github.com').kind).toBe('hostkey')
    expect(isReadOnly('ERROR: The key you are authenticating with has been marked as read only.\nfatal: Could not read from remote repository.')).toBe(true)
    expect(isReadOnly('remote: GitLab: This deploy key does not have write access to this project.')).toBe(true)
    expect(isReadOnly('git@github.com: Permission denied (publickey).')).toBe(false)
  })
})

describe('connecting', () => {
  it('tests with the key, clones, counts what is there, and the wiki indexes it', async () => {
    const r = remote({ 'Marcos Lima.md': '---\ntipo: Pessoa\n---\n\nCliente da reforma.\n', 'Projetos/Reforma.md': 'Obra do [[Marcos Lima]].\n', 'anexos/planta.pdf': '%PDF-1.4', 'anexos/contrato.docx': 'PK' })
    const { test, setup, wiki, dir, secrets, g } = await connected(r.url)
    expect(setup.publicKey).toMatch(/^ssh-ed25519 /)
    expect(secrets.store.get(KEY_SECRET)).toContain('OPENSSH PRIVATE KEY') // kept in the secrets, sealed by the app's cipher
    expect(test).toMatchObject({ branch: 'main', empty: false, pages: 2, pdfs: 1, docx: 1 })
    expect(existsSync(join(dir, '.git'))).toBe(true)
    expect(wiki.list().map((p) => p.title).sort()).toEqual(['Marcos Lima', 'Reforma'])
    expect(wiki.page('Reforma')!.links).toEqual(['Marcos Lima'])
    const st = await g.sync()
    expect(st).toMatchObject({ state: 'ok', readOnly: false })
    expect(st.error).toBeUndefined()
    // what the wiki made of the folder (its schema) went; its index and log didn't
    expect(inRemote(r.bare)).toContain('esquema.md')
    expect(inRemote(r.bare)).not.toContain('índice.md')
    expect(inRemote(r.bare)).not.toContain('registro.md')
  })

  it('works with an empty repository: the first save makes its first commit', async () => {
    const r = remote()
    const { g, wiki, test } = await connected(r.url)
    expect(test).toMatchObject({ empty: true, pages: 0 })
    wiki.save({ title: 'Primeira', body: 'Oi.', by: 'ana', byName: 'Ana' })
    await g.sync()
    expect(inRemote(r.bare)).toContain('pages/Primeira.md')
  })
})

describe('the loop', () => {
  it('a pull picks up a change made on the Mac', async () => {
    const r = remote({ 'Marcos Lima.md': 'Cliente da reforma.\n' })
    const { g, wiki } = await connected(r.url)
    macEdit(r.mac, 'Marcos Lima.md', 'Cliente da reforma. Telefone novo: 41 9999-0000.\n')
    expect((await g.sync()).error).toBeUndefined()
    expect(wiki.page('Marcos Lima')!.body).toContain('Telefone novo')
    expect(wiki.history('Marcos Lima')[0]).toMatchObject({ by: 'outside', action: 'edit' })
  })

  it('a save here is committed and pushed a few seconds later, with the page and who wrote it', async () => {
    const r = remote({ 'Marcos Lima.md': 'Cliente da reforma.\n' })
    const { g, wiki } = await connected(r.url)
    await g.sync()
    ;(g as unknown as { deps: { pushAfter: number } }).deps.pushAfter = 50
    wiki.save({ title: 'Marcos Lima', body: 'Cliente da reforma. Começa em janeiro.', by: 'ana', byName: 'Ana', expectedHash: wiki.page('Marcos Lima')!.hash })
    const end = Date.now() + 20_000
    while (!git(r.bare, 'log', '-1', '--format=%s').includes('Marcos Lima') && Date.now() < end) await new Promise((x) => setTimeout(x, 50))
    expect(git(r.bare, 'log', '-1', '--format=%s|%an|%ae').trim()).toBe('Tucano: Marcos Lima (Ana)|Ana|tucano@users.noreply')
    expect(git(r.bare, 'show', 'main:Marcos Lima.md')).toContain('Começa em janeiro')
    // nothing comes back around: the pull after it has nothing to commit
    const before = git(r.bare, 'rev-parse', 'main')
    await g.sync()
    expect(git(r.bare, 'rev-parse', 'main')).toBe(before)
  })

  it('a conflict keeps the repository’s version in place and Tucano’s as "(versão do Tucano)", with a notice', async () => {
    const r = remote({ 'Marcos Lima.md': 'Cliente da reforma.\n' })
    const { g, wiki, dir } = await connected(r.url)
    await g.sync()
    macEdit(r.mac, 'Marcos Lima.md', 'Cliente da reforma. Orçamento: R$ 12 mil (do Mac).\n')
    wiki.save({ title: 'Marcos Lima', body: 'Cliente da reforma. Orçamento: R$ 15 mil (do Tucano).', by: 'ana', byName: 'Ana', expectedHash: wiki.page('Marcos Lima')!.hash })
    await g.sync()
    expect(readFileSync(join(dir, 'Marcos Lima.md'), 'utf8')).toBe('Cliente da reforma. Orçamento: R$ 12 mil (do Mac).\n')
    expect(readFileSync(join(dir, 'Marcos Lima (versão do Tucano).md'), 'utf8')).toContain('R$ 15 mil (do Tucano)')
    expect(git(r.bare, 'show', 'main:Marcos Lima.md')).toContain('do Mac')
    expect(git(r.bare, 'show', 'main:Marcos Lima (versão do Tucano).md')).toContain('do Tucano')
    const f = wiki.findings().find((x) => x.kind === 'git')!
    expect(f.pages).toEqual(['Marcos Lima', 'Marcos Lima (versão do Tucano)'])
    expect(f.text).toContain('Ficou a versão do repositório')
    expect(wiki.page('Marcos Lima (versão do Tucano)')).toBeTruthy()
    // a review doesn't wipe it
    wiki.setFindings([])
    expect(wiki.findings().some((x) => x.kind === 'git')).toBe(true)
    expect(g.status().state).toBe('ok')
  })

  it('held pages and DM sources are never committed', async () => {
    const r = remote({ 'Marcos Lima.md': 'Cliente.\n' })
    const { g, wiki, dir } = await connected(r.url)
    wiki.save({ title: 'Plano secreto', body: 'Só da Ana.', by: 'ana', byName: 'Ana' })
    wiki.holdKey(pageKey('Plano secreto'), 'ana')
    wiki.save({ title: 'Plano secreto', body: 'Só da Ana, mais.', by: 'ana', byName: 'Ana', expectedHash: wiki.page('Plano secreto')!.hash })
    wiki.save({ title: 'Do time', body: 'Pra todos.', by: 'ana', byName: 'Ana' })
    const dm = wiki.addSource({ title: 'Conversa privada', text: 'o que a Ana disse na DM', kind: 'conversation', origin: { conversationId: 'dm-ana' }, by: 'auto' })
    const ch = wiki.addSource({ title: 'Conversa do canal', text: 'o que se disse no canal', kind: 'conversation', origin: { conversationId: 'canal' }, by: 'auto' })
    await g.sync()
    const files = inRemote(r.bare)
    expect(files).toContain('Do time.md')
    expect(files).not.toContain('Plano secreto.md')
    expect(files).toContain(`${ch.file}.md`)
    expect(files).not.toContain(`${dm.file}.md`)
    expect(git(r.bare, 'log', '--all', '-p').includes('Só da Ana')).toBe(false)
    // nor its title in a commit message (it was written in the same round as "Do time")
    expect(git(r.bare, 'log', '--all', '--format=%s').includes('Plano secreto')).toBe(false)
    expect(git(r.bare, 'log', '-1', '--format=%s').trim()).toBe('Tucano: Do time (Ana)')
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('/Plano secreto.md')
    // released: it's the team's now, and goes
    wiki.release('Plano secreto')
    await g.sync()
    expect(inRemote(r.bare)).toContain('Plano secreto.md')
  })

  it('a file over 50 MB stays out, with a notice', async () => {
    const r = remote({ 'Marcos Lima.md': 'Cliente.\n' })
    const { g, wiki, dir } = await connected(r.url)
    mkdirSync(join(dir, 'anexos'), { recursive: true })
    writeFileSync(join(dir, 'anexos', 'video.mp4'), '')
    truncateSync(join(dir, 'anexos', 'video.mp4'), 51 * 1024 * 1024)
    writeFileSync(join(dir, 'anexos', 'foto.png'), 'png')
    const st = await g.sync()
    expect(inRemote(r.bare)).toContain('anexos/foto.png')
    expect(inRemote(r.bare)).not.toContain('anexos/video.mp4')
    expect(st.skipped).toEqual([{ path: 'anexos/video.mp4', mb: 51 }])
    expect(wiki.findings().find((f) => f.kind === 'git')!.text).toContain('50 MB')
  })
})

describe('a machine with no git identity (a fresh server, CI)', () => {
  it('still rebases and settles a conflict: Tucano commits as itself', async () => {
    const r = remote({ 'Marcos Lima.md': 'Cliente.\n' })
    const { g, wiki, dir } = await connected(r.url)
    expect((await g.sync()).error).toBeUndefined()
    macEdit(r.mac, 'Marcos Lima.md', 'Cliente (do Mac).\n')
    wiki.save({ title: 'Marcos Lima', body: 'Cliente (do Tucano).', by: 'ana', byName: 'Ana', expectedHash: wiki.page('Marcos Lima')!.hash })
    const saved = { ...process.env }
    // no ~/.gitconfig, no system config, and no guessing a name from the machine
    Object.assign(process.env, { HOME: mkdtempSync(join(tmpdir(), 'tucano-home-')), USERPROFILE: mkdtempSync(join(tmpdir(), 'tucano-home-')), XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'tucano-xdg-')), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.useConfigOnly', GIT_CONFIG_VALUE_0: 'true' })
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[k]
    try {
      expect((await g.sync()).error).toBeUndefined()
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
    expect(readFileSync(join(dir, 'Marcos Lima.md'), 'utf8')).toBe('Cliente (do Mac).\n')
    expect(readFileSync(join(dir, 'Marcos Lima (versão do Tucano).md'), 'utf8')).toContain('do Tucano')
    expect(git(r.bare, 'log', '-1', '--format=%cn')).toContain('Tucano')
  })
})

describe('names in NFD', () => {
  // "Reunião" with the ã as a + combining tilde, as a Mac (or a tool on one) may write it. On Linux it's
  // another name than the NFC one; the page stays one file, under the name the repository has.
  const NFD = 'Reunia\u0303o'
  const nfc = (xs: string[]): string[] => xs.map((x) => x.normalize('NFC'))

  it('a page named in NFD is pulled, edited, pushed under its own name, and a conflict on it makes one NFC copy', async () => {
    const r = remote({ [`${NFD}.md`]: 'Pauta.\n' })
    expect(inRemote(r.bare)).toContain(`${NFD}.md`)
    const { g, wiki } = await connected(r.url)
    expect(wiki.page('Reunião')!.body).toContain('Pauta.')
    wiki.save({ title: 'Reunião', body: 'Pauta nova.', by: 'ana', byName: 'Ana', expectedHash: wiki.page('Reunião')!.hash })
    const st = await g.sync()
    expect(st.error).toBeUndefined()
    expect(nfc(inRemote(r.bare)).filter((f) => f === 'Reunião.md')).toHaveLength(1) // not doubled, not renamed
    expect(inRemote(r.bare)).toContain(`${NFD}.md`)
    expect(git(r.bare, 'show', `main:${NFD}.md`)).toContain('Pauta nova')
    expect(git(r.bare, 'log', '-1', '--format=%s')).toContain('Tucano: Reunião (Ana)')
    macEdit(r.mac, `${NFD}.md`, 'Pauta do Mac.\n')
    wiki.save({ title: 'Reunião', body: 'Pauta do Tucano.', by: 'ana', byName: 'Ana', expectedHash: wiki.page('Reunião')!.hash })
    expect((await g.sync()).error).toBeUndefined()
    expect(git(r.bare, 'show', `main:${NFD}.md`)).toContain('Pauta do Mac')
    expect(nfc(inRemote(r.bare))).toContain('Reunião (versão do Tucano).md')
    expect(wiki.findings().find((f) => f.kind === 'git')!.pages).toEqual(['Reunião', 'Reunião (versão do Tucano)'])
  })

  it('a held page named in NFD is never committed', async () => {
    const r = remote({ 'Marcos Lima.md': 'Cliente.\n' })
    const { g, wiki, dir } = await connected(r.url)
    writeFileSync(join(dir, 'Negociac\u0327a\u0303o.md'), 'Só da Ana.\n')
    await wiki.refresh()
    wiki.holdKey(pageKey('Negociação'), 'ana')
    expect(wiki.heldFiles()).toHaveLength(1)
    expect((await g.sync()).error).toBeUndefined()
    expect(nfc(inRemote(r.bare))).not.toContain('Negociação.md')
    expect(git(r.bare, 'log', '--all', '-p').includes('Só da Ana')).toBe(false)
  })
})

describe('a key that only reads', () => {
  it('is found on the first push: the wiki turns read-only, keeps what didn’t go, and takes no writes', async () => {
    const r = remote({ 'Marcos Lima.md': 'Cliente.\n' }, '#!/bin/sh\necho "ERROR: The key you are authenticating with has been marked as read only." >&2\nexit 1\n')
    const { g, wiki, dir } = await connected(r.url)
    wiki.save({ title: 'Nova', body: 'Escrita no Tucano.', by: 'ana', byName: 'Ana' })
    wiki.save({ title: 'Marcos Lima', body: 'Mudada no Tucano.', by: 'ana', byName: 'Ana', expectedHash: wiki.page('Marcos Lima')!.hash })
    const st = await g.sync()
    expect(st).toMatchObject({ readOnly: true, state: 'ok' })
    expect(inRemote(r.bare)).not.toContain('Nova.md')
    expect(readFileSync(join(dir, 'Nova.md'), 'utf8')).toContain('Escrita no Tucano') // new here: stays, only here
    expect(readFileSync(join(dir, 'Marcos Lima.md'), 'utf8')).toBe('Cliente.\n') // the repository's, back in place
    expect(readFileSync(join(dir, 'Marcos Lima (versão do Tucano).md'), 'utf8')).toContain('Mudada no Tucano')
    expect(existsSync(join(dir, 'esquema (versão do Tucano).md'))).toBe(false) // Tucano's own default, not something written
    expect(() => wiki.save({ title: 'Outra', body: 'x', by: 'ana', byName: 'Ana' })).toThrow(/só leitura/)
    expect(wiki.findings().some((f) => f.kind === 'git' && f.text.includes('só pode ler'))).toBe(true)
    // the Mac's changes (its own key writes) still come in
    const hook = join(r.bare, 'hooks', 'pre-receive')
    renameSync(hook, `${hook}.off`)
    macEdit(r.mac, 'Notas do Mac.md', 'Do Mac.\n')
    macEdit(r.mac, 'Nova.md', 'A Nova do Mac.\n') // the name of the page kept only here
    renameSync(`${hook}.off`, hook)
    await g.sync()
    expect(wiki.page('Notas do Mac')!.body).toContain('Do Mac')
    expect(readFileSync(join(dir, 'Nova.md'), 'utf8')).toBe('A Nova do Mac.\n')
    expect(readFileSync(join(dir, 'Nova (versão do Tucano).md'), 'utf8')).toContain('Escrita no Tucano')
    // "Tentar escrever de novo" with the key still read-only: read-only again, nothing lost
    expect((await g.sync({ write: true })).readOnly).toBe(true)
    // the key now writes: the copy kept here goes up
    renameSync(hook, `${hook}.off`)
    expect((await g.sync({ write: true })).readOnly).toBe(false)
    expect(inRemote(r.bare)).toContain('Nova.md')
    expect(inRemote(r.bare)).toContain('Marcos Lima (versão do Tucano).md')
    expect(inRemote(r.bare).filter((f) => f.includes('versão do Tucano) (versão'))).toEqual([])
    wiki.save({ title: 'Outra', body: 'agora vai', by: 'ana', byName: 'Ana' })
  })
})

describe('a refused key', () => {
  // A stand-in for ssh that says what GitHub says to a key it doesn't know, after printing the key
  // file it was given: none of it may reach the status, the errors or the log.
  const fakeSsh = (): string => {
    const f = join(mkdtempSync(join(tmpdir(), 'tucano-ssh-')), 'ssh')
    writeFileSync(f, '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-i" ]; then cat "$2" >&2; echo "using $2" >&2; fi; shift; done\necho "git@github.com: Permission denied (publickey)." >&2\nexit 255\n')
    chmodSync(f, 0o755)
    return f
  }

  it('fails the test with words, and nothing of the key', async () => {
    const data = mkdtempSync(join(tmpdir(), 'tucano-data-'))
    const secrets = memSecrets()
    let meta: string | undefined
    const g = new WikiGit({ dataDir: data, secrets, load: () => meta, store: (j) => void (meta = j), privatePaths: () => new Set(), quiet: () => {}, refresh: async () => {}, notice: () => {}, changed: () => {}, currentPages: () => 0, ssh: fakeSsh() })
    await g.setup('git@github.com:edu/vault.git')
    const e = await g.test().then(() => null, (x: unknown) => x)
    expect(e).toBeInstanceOf(GitFailure)
    expect((e as GitFailure).error.kind).toBe('auth')
    const key = JSON.parse(secrets.store.get(KEY_SECRET)!).privateKey as string
    expect((e as Error).message).not.toContain('PRIVATE KEY')
    for (const line of key.split('\n').filter((l) => l.length > 20)) expect((e as Error).message).not.toContain(line)
    expect(meta).not.toContain('PRIVATE KEY')
    // and the key file is gone once git is done
    expect(execFileSync('sh', ['-c', `ls -d ${tmpdir()}/tucano-key-* 2>/dev/null || true`], { encoding: 'utf8' }).trim()).toBe('')
  })

  it('a key revoked after connecting: an auth status, a retry time, and a log with no key', async () => {
    const r = remote({ 'Marcos Lima.md': 'Cliente.\n' })
    const { g, dir, logs, secrets } = await connected(r.url, { ssh: fakeSsh() })
    git(dir, 'remote', 'set-url', 'origin', 'git@github.com:edu/vault.git')
    ;(g as unknown as { cfg: { sshUrl: string; host: string } }).cfg.host = 'github.com'
    const st = await g.sync()
    expect(st.state).toBe('error')
    expect(st.error!.kind).toBe('auth')
    expect(st.error!.message).toContain('recusou a chave')
    expect(st.nextTry).toBeGreaterThan(Date.now())
    const key = JSON.parse(secrets.store.get(KEY_SECRET)!).privateKey as string
    const seen = JSON.stringify([st, logs])
    expect(seen).not.toContain('PRIVATE KEY')
    for (const line of key.split('\n').filter((l) => l.length > 20)) expect(seen).not.toContain(line)
    expect(seen).not.toMatch(/tucano-key-/)
    g.stop()
  })
})

describe('the curator and the repository', () => {
  it('pulls before it writes, and with a read-only repository asks no model and writes nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tucano-wiki-'))
    let ro: string | undefined
    const order: string[] = []
    const w = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db'), readOnly: () => ro, onWrite: (x) => void order.push(`write:${x.title}`) })
    w.init(false)
    const msg = { id: 'm1', conversationId: 'c', author: { kind: 'person', id: 'me' }, text: 'Guarda: o trem sai às 8h15.', at: 1 } as Message
    const curator = new WikiCurator({
      wiki: w,
      db: { conversation: (id) => ({ id, kind: 'channel', name: 'geral' }), messagesAfter: () => [msg], messagesSaidAfter: () => [msg], message: (id) => (id === 'm1' ? msg : undefined), saveMessage: () => {}, agents: () => [] },
      settings: () => ({ workspaceName: 'Ana' }) as Settings,
      llm: async () => (order.push('llm'), JSON.stringify({ guardar: true, titulo_fonte: 'Trem', mudancas: [{ op: 'create', pagina: 'Viagem', tipo: 'Projeto', texto: 'Trem às 8h15.' }] })),
      emitMessage: () => {},
      beforeWrite: async () => void order.push('pull')
    })
    await curator.keepMessage('m1')
    expect(order).toEqual(['llm', 'pull', 'write:Viagem'])
    ro = 'A wiki está só leitura.'
    await expect(curator.keepMessage('m1')).rejects.toThrow('só leitura')
    expect(order.filter((x) => x === 'llm')).toHaveLength(1)
  })
})
