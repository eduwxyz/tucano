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
// refs/tucano/changes/<id>/ so git's cleanup doesn't take them while the reply can still be opened.
// The message keeps only the counts and the first files; a file's diff is asked for when it's opened.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, realpathSync, rmSync, statSync, utimesSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ChangeSet, FileChange } from '../shared/types'

export const CHANGE_FILES_SHOWN = 20 // the files a message carries; the rest come on "show more"
const PATCH_MAX = 1_000_000 // a file's diff past this is cut
const GIT_TIMEOUT = 120_000
const AUTHOR = { name: 'Tucano', email: 'tucano@users.noreply.github.com' }
const REFS = 'refs/tucano/changes'

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

function git(bin: string, cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<Git> {
  return new Promise((done) => {
    execFile(
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
  before: string
  after: string
  files: FileChange[]
  createdAt: number
}

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
    if (!set || !file) return { error: 'gone' }
    if (!existsSync(set.root)) return { error: 'missing' }
    const paths = file.from ? [file.from, file.path] : [file.path]
    const r = await git(this.bin(), set.root, ['-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/', set.before, set.after, '--', ...paths])
    if (r.code !== 0) return { error: /bad object|unknown revision|not a valid object/i.test(r.err) ? 'gone' : 'failed' }
    return r.out.length > PATCH_MAX ? { patch: cutPatch(r.out), truncated: true } : { patch: r.out }
  }
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
        for (const base of this.scope.bases) for (const dir of [base, ...children(base)]) if (existsSync(join(dir, '.git'))) await this.watch(dir)
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
    if (this.refused.has(dir) || [...this.watched.keys()].some((r) => inside(dir, r))) return
    const top = await git(this.bin, dir, ['rev-parse', '--show-toplevel'])
    const root = top.code === 0 ? real(resolve(top.out.trim())) : undefined
    if (!root || this.watched.has(root) || this.refused.has(root)) {
      if (!root) this.refused.add(dir)
      return
    }
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

  // When the turn ends: what each repository it wrote in has changed, kept for the message.
  async finish(messageId: string, agentId: string): Promise<ChangeSet[]> {
    await this.queue
    const sets: ChangeSet[] = []
    for (const w of this.watched.values()) {
      const after = await snapshot(this.bin, w.root, `${REFS}/${w.id}/after`)
      const files = after ? await changedFiles(this.bin, w.root, w.before, after) : []
      if (!after || !files.length) {
        await git(this.bin, w.root, ['update-ref', '-d', `${REFS}/${w.id}/before`])
        if (after) await git(this.bin, w.root, ['update-ref', '-d', `${REFS}/${w.id}/after`])
        continue
      }
      const shown = this.scope.shown(w.named)
      const branch = await branchOf(this.bin, w.root)
      try {
        this.deps.saveChangeSet({ id: w.id, messageId, agentId, root: w.root, shown, before: w.before, after, files, createdAt: Date.now() })
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
        files: files.slice(0, CHANGE_FILES_SHOWN)
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

async function changedFiles(bin: string, root: string, before: string, after: string): Promise<FileChange[]> {
  const common = ['diff', '--no-ext-diff', '--no-textconv', '-M', '-z', before, after]
  const [numstat, status] = await Promise.all([git(bin, root, [...common, '--numstat']), git(bin, root, [...common, '--name-status'])])
  if (numstat.code !== 0 || status.code !== 0) return []
  return parseChanges(numstat.out, status.out)
}

// How a folder of this computer is named in what's shown: under the home folder, with ~.
export function homePath(p: string): string {
  const home = homedir()
  return inside(p, home) && p !== home ? `~${sep}${relative(home, p)}` : p
}
