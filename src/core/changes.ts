// What a reply changed in the person's code, as a git diff they can open file by file.
//
// Around a turn of an agent with a computer, each git repository it may write in gets a snapshot of
// its working tree before the first command or write, and another when the turn ends. Comparing the
// two shows every file the turn created, changed, renamed or deleted, whatever did it: write_file and
// edit_file, but also rm, sed, a code generator or npm in bash.
//
// A snapshot is a commit made from a scratch copy of the repository's index (GIT_INDEX_FILE), with
// `git add -A` over the working tree: the person's staging area, branches and log stay as they were,
// and what .gitignore leaves out (node_modules, builds) stays out. The commits are kept under
// refs/tucano/changes/<id>/ so git's cleanup doesn't take them while the reply can still be opened,
// and taken out by the daily sweep after CHANGES_KEEP_DAYS (or when the message is deleted).
// The message keeps only the counts and the first files; a file's diff is asked for when it's opened.
//
// A folder of the agent's without git gets the same, from a repository of Tucano's own (in its data
// folder) whose working tree is that folder: nothing is written in the folder itself.
//
// The person can then keep or undo each file: undo writes it back as the first snapshot had it,
// unless it changed again since the reply (another reply, the person): then only when they insist.
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CHANGES_KEEP_DAYS, type ChangeSet, type FileChange } from '../shared/types'

export const CHANGE_FILES_SHOWN = 20 // the files a message carries; the rest come on "show more"
const PATCH_MAX = 1_000_000 // a file's diff past this is cut
const GIT_TIMEOUT = 120_000
const AUTHOR = { name: 'Tucano', email: 'tucano@users.noreply.github.com' }
const REFS = 'refs/tucano/changes'
// A folder without git: past this many files it isn't followed (a disk, a downloads folder), and a
// file past this size is left out, so Tucano's copy of it stays small.
const PLAIN_MAX_FILES = 20_000
const PLAIN_MAX_SIZE = 5 * 1024 * 1024
// What a folder without git leaves out, as a .gitignore would: installed packages, caches.
const PLAIN_SKIP = ['node_modules/', 'vendor/', '.venv/', 'venv/', '__pycache__/', '.next/', '.nuxt/', '.cache/', '.gradle/', '.tox/', '.DS_Store', 'Thumbs.db']

// The tools that may change files, and whose call is preceded by a look for repositories.
export const CHANGING_TOOLS = new Set(['bash', 'write_file', 'edit_file', 'start_service'])

// Where an agent's computer writes, as seen from this computer.
export interface ChangeScope {
  bases: string[] // the folders it writes into that are the person's (its work folder, lent folders), here
  toHost: (p: string) => string | undefined // a path as the agent says it, here; undefined: not the person's
  shown: (host: string) => string // a path here, as the agent sees it
}

interface Git {
  code: number
  out: string
  err: string
}

// A folder without git is worked on through Tucano's repository for it.
const at = (gitDir: string | undefined, root: string): NodeJS.ProcessEnv => (gitDir ? { GIT_DIR: gitDir, GIT_WORK_TREE: root } : {})

function git(bin: string, cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string): Promise<Git> {
  return new Promise((done) => {
    const child = execFile(
      bin,
      ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-c', 'core.splitIndex=false', '-c', 'color.ui=never', ...args],
      {
        cwd,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email, ...env },
        maxBuffer: 64 * 1024 * 1024,
        timeout: GIT_TIMEOUT,
        windowsHide: true
      },
      (e, stdout, stderr) => {
        const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : -1) : 0
        done({ code, out: String(stdout), err: String(stderr) })
      }
    )
    if (input !== undefined) child.stdin?.end(input)
  })
}

// The paths a call may change, as the agent says them: the file it writes, or for a command, where it
// starts and where it goes (`cd x && …`, `git -C x …`).
export function touched(name: string, args: Record<string, unknown>): string[] {
  const s = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string).trim() : '')
  if (name === 'write_file' || name === 'edit_file') return s('path') ? [s('path')] : []
  const command = s('command')
  if (!command) return []
  const unquote = (w: string): string => w.replace(/^(['"])(.*)\1$/, '$2')
  const out = new Set<string>()
  for (const m of command.matchAll(/(?:^|[;&|(]\s*)cd\s+((?:"[^"]+"|'[^']+'|[^\s;&|)]+))/g)) out.add(unquote(m[1]!))
  for (const m of command.matchAll(/\bgit\s+-C\s+((?:"[^"]+"|'[^']+'|[^\s;&|)]+))/g)) out.add(unquote(m[1]!))
  for (const m of command.matchAll(/\bpushd\s+((?:"[^"]+"|'[^']+'|[^\s;&|)]+))/g)) out.add(unquote(m[1]!))
  return [...out].filter((p) => p !== '-' && !p.includes('$'))
}

// Lines added and removed between two texts, as a diff would count them.
export function lineChange(before: string, after: string): { added: number; removed: number } {
  const split = (t: string): string[] => (t === '' ? [] : t.replace(/\r?\n$/, '').split(/\r?\n/))
  const a = split(before)
  const b = split(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--
  const n = endA - start
  const m = endB - start
  if (!n || !m || n * m > 4_000_000) return { added: m, removed: n }
  // The longest common subsequence of what's left in between, one row at a time.
  let prev = new Uint32Array(m + 1)
  let row = new Uint32Array(m + 1)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) row[j] = a[start + i - 1] === b[start + j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!)
    ;[prev, row] = [row, prev]
  }
  const same = prev[m]!
  return { added: m - same, removed: n - same }
}

const inside = (child: string, parent: string): boolean => {
  const r = relative(parent, child)
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

// numstat and name-status, both with -z, into one list of files.
export function parseChanges(numstat: string, status: string): FileChange[] {
  const files: FileChange[] = []
  const byPath = new Map<string, FileChange>()
  const st = status.split('\0')
  for (let i = 0; i < st.length - 1; ) {
    const code = st[i++]!
    if (!code) continue
    const kind = code[0]
    if (kind === 'R' || kind === 'C') {
      const from = st[i++]!
      const path = st[i++]!
      const f: FileChange = { path, kind: kind === 'R' ? 'renamed' : 'added', added: 0, removed: 0, ...(kind === 'R' ? { from } : {}) }
      files.push(f), byPath.set(path, f)
    } else {
      const path = st[i++]!
      const f: FileChange = { path, kind: kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'modified', added: 0, removed: 0 }
      files.push(f), byPath.set(path, f)
    }
  }
  const ns = numstat.split('\0')
  for (let i = 0; i < ns.length - 1; ) {
    const head = ns[i++]!
    if (!head) continue
    const [added, removed, path] = head.split('\t')
    // A rename: the counts, then an empty path, then the old and the new one.
    const target = path ? path : (i++, ns[i++]!)
    const f = byPath.get(target!)
    if (!f) continue
    if (added === '-' || removed === '-') f.binary = true
    else (f.added = Number(added) || 0), (f.removed = Number(removed) || 0)
  }
  return files
}

export interface ChangesDeps {
  saveChangeSet: (row: ChangeSetRow) => void
  changeSet: (id: string) => ChangeSetRow | undefined
  staleChangeSets?: (before: number) => { row: ChangeSetRow; orphan: boolean }[]
  dropChangeSet?: (id: string, orphan: boolean) => void
  dir?: string // where the repositories of folders without git are kept; unset: those aren't followed
  git?: string
  log?: (line: string) => void
}

// What's kept of a changeset: the counts and every file, and where to find its two snapshots.
export interface ChangeSetRow {
  id: string
  messageId: string
  agentId: string
  root: string // the repository, on this computer
  shown: string // the repository, as the agent sees it
  gitDir?: string // a folder without git: Tucano's repository for it
  before: string
  after: string
  files: FileChange[]
  createdAt: number
  expired?: boolean // its snapshots were taken out
}

export type UndoResult = { undone: string[]; changed: string[]; failed: string[] } | { error: 'gone' | 'missing' }

export class Changes {
  constructor(private deps: ChangesDeps) {}

  private bin(): string {
    return this.deps.git ?? process.env['TUCANO_GIT'] ?? 'git'
  }

  // One reply's watch over the repositories its agent writes in.
  turn(scope: ChangeScope): ChangeTurn {
    return new ChangeTurn(this.bin(), scope, this.deps)
  }

  // The files of a changeset past the first ones the message carries.
  files(id: string, offset: number, limit = 200): FileChange[] | undefined {
    return this.deps.changeSet(id)?.files.slice(Math.max(0, offset), Math.max(0, offset) + Math.min(500, Math.max(1, limit)))
  }

  // One file's diff, as a patch: asked for when it's opened in the chat.
  async diff(id: string, path: string): Promise<{ patch: string; truncated?: boolean } | { error: 'gone' | 'missing' | 'failed' }> {
    const set = this.deps.changeSet(id)
    const file = set?.files.find((f) => f.path === path)
    if (!set || !file || set.expired) return { error: 'gone' }
    if (!existsSync(set.root)) return { error: 'missing' }
    const paths = file.from ? [file.from, file.path] : [file.path]
    const r = await git(this.bin(), set.root, ['-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/', set.before, set.after, '--', ...paths], at(set.gitDir, set.root))
    if (r.code !== 0) return { error: /bad object|unknown revision|not a valid object|not a git repository/i.test(r.err) ? 'gone' : 'failed' }
    return r.out.length > PATCH_MAX ? { patch: cutPatch(r.out), truncated: true } : { patch: r.out }
  }

  // Files of a changeset put back as they were before the reply. One that changed again since (by
  // another reply, by the person) is left as it is and named in `changed`, unless `force`.
  async undo(id: string, paths: string[], force = false): Promise<UndoResult> {
    const set = this.deps.changeSet(id)
    if (!set || set.expired) return { error: 'gone' }
    if (!existsSync(set.root)) return { error: 'missing' }
    const out = { undone: [] as string[], changed: [] as string[], failed: [] as string[] }
    const bin = this.bin()
    const env = at(set.gitDir, set.root)
    for (const path of new Set(paths)) {
      const file = set.files.find((f) => f.path === path)
      if (!file) {
        out.failed.push(path)
        continue
      }
      try {
        // As the reply left them: the file where it ended, and (moved) nothing where it was.
        const now = await same(bin, set.root, env, set.after, file.path)
        const left = !file.from || !(await present(set.root, file.from))
        if (now === undefined) {
          out.failed.push(path)
          continue
        }
        if (!force && (!now || !left)) {
          out.changed.push(path)
          continue
        }
        if (file.kind === 'added' || file.kind === 'renamed') remove(set.root, file.path)
        else if (!(await putBack(bin, set.root, env, set.before, file.path))) throw new Error('not put back')
        if (file.from && !(await putBack(bin, set.root, env, set.before, file.from))) throw new Error('not put back')
        out.undone.push(path)
      } catch (e) {
        this.deps.log?.(`[changes] undo ${path}: ${(e as Error).message}`)
        out.failed.push(path)
      }
    }
    return out
  }

  // The snapshots of replies older than CHANGES_KEEP_DAYS, or whose message was deleted, out of the
  // repositories they're kept in: git's own cleanup then takes what only they held. Returns the
  // changesets that expired (their message stays, saying so).
  async sweep(now = Date.now()): Promise<{ id: string; messageId: string }[]> {
    const stale = this.deps.staleChangeSets?.(now - CHANGES_KEEP_DAYS * 86_400_000) ?? []
    const bin = this.bin()
    const ours = new Set<string>()
    const expired: { id: string; messageId: string }[] = []
    for (const { row, orphan } of stale) {
      if (!row.expired && existsSync(row.root) && (!row.gitDir || existsSync(row.gitDir))) {
        for (const end of ['before', 'after']) await git(bin, row.root, ['update-ref', '-d', `${REFS}/${row.id}/${end}`], at(row.gitDir, row.root))
      }
      if (row.gitDir) ours.add(`${row.gitDir}\0${row.root}`)
      this.deps.dropChangeSet?.(row.id, orphan)
      if (!orphan) expired.push({ id: row.id, messageId: row.messageId })
    }
    // Tucano's own repositories are cleaned now; one whose folder is gone, removed.
    for (const key of ours) {
      const [gitDir, root] = key.split('\0') as [string, string]
      if (!existsSync(root)) rmSync(gitDir, { recursive: true, force: true })
      else if (existsSync(gitDir)) await git(bin, root, ['gc', '--prune=now', '--quiet'], at(gitDir, root))
    }
    return expired
  }
}

// Whether a file is as `commit` has it: true, false (changed, or there and shouldn't be, or the
// reverse), undefined when git can't say.
async function same(bin: string, root: string, env: NodeJS.ProcessEnv, commit: string, path: string): Promise<boolean | undefined> {
  const entry = await treeEntry(bin, root, env, commit, path)
  if (entry === undefined) return undefined
  let st
  try {
    st = lstatSync(join(root, path))
  } catch {
    return entry === null
  }
  if (!entry) return false
  if (entry.mode === '120000') {
    if (!st.isSymbolicLink()) return false
    const h = await git(bin, root, ['hash-object', '--no-filters', '--stdin'], env, readlinkSync(join(root, path)))
    return h.code === 0 ? h.out.trim() === entry.oid : undefined
  }
  if (!st.isFile()) return false
  const h = await git(bin, root, ['hash-object', '--', path], env)
  return h.code === 0 ? h.out.trim() === entry.oid : undefined
}

// A path's entry in a commit: null when it isn't there, undefined when git can't say.
async function treeEntry(bin: string, root: string, env: NodeJS.ProcessEnv, commit: string, path: string): Promise<{ mode: string; oid: string } | null | undefined> {
  const r = await git(bin, root, ['ls-tree', '-z', commit, '--', path], env)
  if (r.code !== 0) return undefined
  const line = r.out.split('\0').find((l) => l.endsWith(`\t${path}`))
  if (!line) return null
  const [mode, , oid] = line.slice(0, line.indexOf('\t')).split(' ')
  return mode && oid ? { mode, oid } : undefined
}

async function present(root: string, path: string): Promise<boolean> {
  try {
    lstatSync(join(root, path))
    return true
  } catch {
    return false
  }
}

// A file written back as `commit` has it (its line endings as git would check it out, its mode, a
// link as a link); when `commit` doesn't have it, removed.
async function putBack(bin: string, root: string, env: NodeJS.ProcessEnv, commit: string, path: string): Promise<boolean> {
  const entry = await treeEntry(bin, root, env, commit, path)
  if (entry === undefined) return false
  if (entry === null) return remove(root, path), true
  if (entry.mode === '160000') return false // a repository inside: not ours to move
  const full = join(root, path)
  const body = await gitBytes(bin, root, entry.mode === '120000' ? ['cat-file', 'blob', entry.oid] : ['cat-file', '--filters', `${commit}:${path}`], env)
  if (!body) return false
  try {
    if (lstatSync(full).isDirectory()) return false
    unlinkSync(full)
  } catch {
    // not there: written new
  }
  mkdirSync(dirname(full), { recursive: true })
  if (entry.mode === '120000') symlinkSync(body.toString('utf8'), full)
  else {
    writeFileSync(full, body)
    if (process.platform !== 'win32') chmodSync(full, entry.mode === '100755' ? 0o755 : 0o644)
  }
  return true
}

// A file the reply made, removed, and the folders it leaves empty up to the root.
function remove(root: string, path: string): void {
  rmSync(join(root, path), { force: true })
  for (let dir = dirname(join(root, path)); inside(dir, root) && dir !== root; dir = dirname(dir)) {
    try {
      if (readdirSync(dir).length) break
      rmdirSync(dir)
    } catch {
      break
    }
  }
}

function gitBytes(bin: string, cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<Buffer | undefined> {
  return new Promise((done) => {
    execFile(bin, args, { cwd, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env }, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: GIT_TIMEOUT, windowsHide: true }, (e, stdout) =>
      done(e ? undefined : stdout)
    )
  })
}

// A patch cut at the last whole hunk before the limit, so it still parses.
function cutPatch(patch: string): string {
  const head = patch.slice(0, PATCH_MAX)
  const at = head.lastIndexOf('\n@@ ')
  return at > 0 ? `${head.slice(0, at)}\n` : head.slice(0, head.lastIndexOf('\n') + 1)
}

interface Watched {
  id: string
  root: string // its real path, as git names it
  named: string // the same folder as the agent's folders name it (for what's shown)
  gitDir?: string // a folder without git: Tucano's repository for it
  left?: Set<string> // and what it leaves out (repositories inside it, big files)
  before: string
  branch?: string // where the repository was when the turn started
}

export class ChangeTurn {
  private watched = new Map<string, Watched>() // by repository root
  private refused = new Set<string>() // folders already looked at that hold no repository to watch
  private looked = false // the person's folders looked at for repositories, once per turn
  private queue: Promise<void> = Promise.resolve()
  // The agent's folders by their real paths too: git names a repository by its real path, which
  // isn't how the folder may be named here (/var and /private/var on macOS, a short C:\Users\RUNNER~1
  // and the long name on Windows, a symlink).
  private bases: { named: string; real: string }[]

  constructor(
    private bin: string,
    private scope: ChangeScope,
    private deps: ChangesDeps
  ) {
    this.bases = scope.bases.map((b) => ({ named: b, real: real(b) }))
  }

  // Before a call that may change files: snapshots of the repositories it may write in, not yet seen this turn.
  prepare(name: string, args: Record<string, unknown>): Promise<void> {
    if (!CHANGING_TOOLS.has(name)) return Promise.resolve()
    const next = this.queue.then(async () => {
      if (!this.looked) {
        this.looked = true
        for (const base of this.scope.bases) {
          for (const dir of children(base)) if (existsSync(join(dir, '.git'))) await this.watch(dir)
          await this.watch(base) // a repository, or a folder without git
        }
      }
      for (const p of touched(name, args)) {
        const host = this.scope.toHost(p)
        if (host) await this.watch(host)
      }
    })
    this.queue = next.catch(() => {})
    return this.queue
  }

  private async watch(path: string): Promise<void> {
    let dir = resolve(path)
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir)
    try {
      if (!statSync(dir).isDirectory()) dir = dirname(dir)
    } catch {
      return
    }
    dir = real(dir)
    // Already watched (a folder inside a repository seen this turn), or known to hold none.
    if (this.refused.has(dir) || [...this.watched.values()].some((w) => !w.gitDir && inside(dir, w.root))) return
    const top = await git(this.bin, dir, ['rev-parse', '--show-toplevel'])
    const root = top.code === 0 ? real(resolve(top.out.trim())) : undefined
    if (!root) {
      // No git here: the agent's folder it's in is followed as a whole, from Tucano's repository.
      const base = this.bases.find((b) => inside(dir, b.real))
      if (base) await this.watchPlain(base)
      this.refused.add(dir)
      return
    }
    if (this.watched.has(root) || this.refused.has(root)) return
    // Only a repository of the person's own work: inside the folder it was found in (not the one a
    // data folder happens to sit in), and never the whole home folder or more.
    const base = this.bases.find((b) => inside(dir, b.real))
    if ((base && !inside(root, base.real)) || inside(real(homedir()), root)) {
      this.refused.add(root)
      return
    }
    const id = randomUUID()
    const before = await snapshot(this.bin, root, `${REFS}/${id}/before`)
    if (!before) {
      this.deps.log?.(`[changes] no snapshot of ${root}`)
      this.refused.add(root)
      return
    }
    const named = base ? join(base.named, relative(base.real, root)) : root
    this.watched.set(root, { id, root, named, before, branch: await branchOf(this.bin, root) })
  }

  private async watchPlain(base: { named: string; real: string }): Promise<void> {
    const root = base.real
    const dir = this.deps.dir
    if (!dir || this.watched.has(root) || this.refused.has(root) || inside(real(homedir()), root) || dirname(root) === root) return
    const gitDir = join(dir, createHash('sha256').update(root).digest('hex').slice(0, 24))
    const id = randomUUID()
    const left = new Set<string>()
    const before = await plainSnapshot(this.bin, root, gitDir, `${REFS}/${id}/before`, left)
    if (!before) {
      this.deps.log?.(`[changes] not following ${root}: too big, or no snapshot`)
      this.refused.add(root)
      return
    }
    this.watched.set(root, { id, root, named: base.named, gitDir, left, before })
  }

  // When the turn ends: what each repository it wrote in has changed, kept for the message.
  async finish(messageId: string, agentId: string): Promise<ChangeSet[]> {
    await this.queue
    const sets: ChangeSet[] = []
    for (const w of this.watched.values()) {
      const env = at(w.gitDir, w.root)
      const after = w.gitDir ? await plainSnapshot(this.bin, w.root, w.gitDir, `${REFS}/${w.id}/after`, w.left ?? new Set(), false) : await snapshot(this.bin, w.root, `${REFS}/${w.id}/after`)
      const files = after ? await changedFiles(this.bin, w.root, w.before, after, env) : []
      if (!after || !files.length) {
        await git(this.bin, w.root, ['update-ref', '-d', `${REFS}/${w.id}/before`], env)
        if (after) await git(this.bin, w.root, ['update-ref', '-d', `${REFS}/${w.id}/after`], env)
        continue
      }
      const shown = this.scope.shown(w.named)
      const branch = w.gitDir ? undefined : await branchOf(this.bin, w.root)
      try {
        this.deps.saveChangeSet({ id: w.id, messageId, agentId, root: w.root, shown, ...(w.gitDir ? { gitDir: w.gitDir } : {}), before: w.before, after, files, createdAt: Date.now() })
      } catch (e) {
        this.deps.log?.(`[changes] not kept: ${(e as Error).message}`)
        continue
      }
      sets.push({
        id: w.id,
        root: shown,
        ...(branch ? { branch } : {}),
        // The turn moved to another branch (git checkout -b): where its work started from.
        ...(branch && w.branch && w.branch !== branch ? { fromBranch: w.branch } : {}),
        total: files.length,
        added: files.reduce((s, f) => s + f.added, 0),
        removed: files.reduce((s, f) => s + f.removed, 0),
        files: files.slice(0, CHANGE_FILES_SHOWN),
        ...(w.gitDir ? { plain: true } : {})
      })
    }
    this.watched.clear()
    return sets
  }
}

// A path with its links and short names resolved; as it is when it can't be.
function real(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

function children(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => join(dir, d.name))
  } catch {
    return []
  }
}

// The working tree as a commit, kept at `ref`; undefined when git can't.
async function snapshot(bin: string, root: string, ref: string): Promise<string | undefined> {
  const paths = await git(bin, root, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-path', 'index'])
  if (paths.code !== 0) return undefined
  const [common, index] = paths.out.trim().split('\n')
  if (!common || !index) return undefined
  const scratch = join(common, `tucano-index-${randomUUID()}`)
  try {
    // Starting from the person's index keeps git's record of each file's size and time, so only
    // what changed is read again. Its time is kept too: git trusts a file written in the same
    // second as the index less, and a newer copy would hide that.
    if (existsSync(index)) {
      copyFileSync(index, scratch)
      const t = statSync(index)
      utimesSync(scratch, t.atime, t.mtime)
    }
    const env = { GIT_INDEX_FILE: scratch }
    const add = await git(bin, root, ['add', '-A', '--ignore-errors', '--', '.'], env)
    if (add.code !== 0 && !/unable to index|error: open/.test(add.err)) return undefined
    const tree = await git(bin, root, ['write-tree'], env)
    if (tree.code !== 0) return undefined
    const commit = await git(bin, root, ['commit-tree', tree.out.trim(), '-m', 'Tucano: snapshot of a reply'])
    if (commit.code !== 0) return undefined
    const oid = commit.out.trim()
    await git(bin, root, ['update-ref', ref, oid])
    return oid
  } finally {
    rmSync(scratch, { force: true })
    rmSync(`${scratch}.lock`, { force: true })
  }
}

// The branch a repository is on; a detached HEAD by its short commit.
async function branchOf(bin: string, root: string): Promise<string | undefined> {
  const named = await git(bin, root, ['symbolic-ref', '--short', '-q', 'HEAD'])
  if (named.code === 0 && named.out.trim()) return named.out.trim()
  const detached = await git(bin, root, ['rev-parse', '--short', 'HEAD'])
  return detached.code === 0 && detached.out.trim() ? detached.out.trim() : undefined
}

// A folder without git as a commit of Tucano's repository for it (made the first time). What it
// leaves out (`left`: repositories inside it, files too big) is decided on the first snapshot and
// kept for the second, so a file isn't seen as made or deleted for being left out only once.
// undefined when it's too big to follow (`first`) or git can't.
async function plainSnapshot(bin: string, root: string, gitDir: string, ref: string, left: Set<string>, first = true): Promise<string | undefined> {
  const env = at(gitDir, root)
  if (!existsSync(join(gitDir, 'HEAD'))) {
    mkdirSync(gitDir, { recursive: true })
    if ((await git(bin, root, ['init', '-q'], env)).code !== 0) return undefined
    await git(bin, root, ['config', 'core.autocrlf', 'false'], env)
  }
  const exclude = join(gitDir, 'info', 'exclude')
  const write = (): void => {
    mkdirSync(dirname(exclude), { recursive: true })
    writeFileSync(exclude, [...PLAIN_SKIP, ...[...left].map(ignoreLine)].join('\n') + '\n')
  }
  write()
  // The files git doesn't have yet: a repository inside shows as its folder, with a slash.
  const ls = await git(bin, root, ['ls-files', '-o', '-z', '--exclude-standard'], env)
  if (ls.code !== 0) return undefined
  let count = 0
  for (const p of ls.out.split('\0')) {
    if (!p) continue
    if (p.endsWith('/')) {
      left.add(p)
      continue
    }
    if (first && ++count > PLAIN_MAX_FILES) return undefined
    try {
      if (statSync(join(root, p)).size > PLAIN_MAX_SIZE) left.add(p)
    } catch {
      // gone meanwhile
    }
  }
  write()
  // On a copy of its index, as for a repository: two agents lent the same folder can snapshot it at
  // once. The newest copy is kept, so the next snapshot only reads what changed since.
  const index = join(gitDir, 'index')
  const scratch = join(gitDir, `tucano-index-${randomUUID()}`)
  try {
    if (existsSync(index)) {
      copyFileSync(index, scratch)
      const t = statSync(index)
      utimesSync(scratch, t.atime, t.mtime)
    }
    const withIndex = { ...env, GIT_INDEX_FILE: scratch }
    const add = await git(bin, root, ['add', '-A', '--ignore-errors', '--', '.'], withIndex)
    if (add.code !== 0 && !/unable to index|error: open/.test(add.err)) return undefined
    const tree = await git(bin, root, ['write-tree'], withIndex)
    if (tree.code !== 0) return undefined
    const commit = await git(bin, root, ['commit-tree', tree.out.trim(), '-m', 'Tucano: snapshot of a reply'], env)
    if (commit.code !== 0) return undefined
    const oid = commit.out.trim()
    await git(bin, root, ['update-ref', ref, oid], env)
    try {
      renameSync(scratch, index)
    } catch {
      // another snapshot's copy is kept instead
    }
    return oid
  } finally {
    rmSync(scratch, { force: true })
    rmSync(`${scratch}.lock`, { force: true })
  }
}

// One path, from the folder's root, as a line of a .gitignore that matches only it.
function ignoreLine(p: string): string {
  return '/' + p.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`).replace(/ $/, '\\ ')
}

async function changedFiles(bin: string, root: string, before: string, after: string, env: NodeJS.ProcessEnv = {}): Promise<FileChange[]> {
  const common = ['diff', '--no-ext-diff', '--no-textconv', '-M', '-z', before, after]
  const [numstat, status] = await Promise.all([git(bin, root, [...common, '--numstat'], env), git(bin, root, [...common, '--name-status'], env)])
  if (numstat.code !== 0 || status.code !== 0) return []
  return parseChanges(numstat.out, status.out)
}

// How a folder of this computer is named in what's shown: under the home folder, with ~.
export function homePath(p: string): string {
  const home = homedir()
  return inside(p, home) && p !== home ? `~${sep}${relative(home, p)}` : p
}
