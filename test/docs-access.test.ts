// Who may do what in Documentos: the pure rules (shared/doc-access.ts), the small helpers of shared/docs.ts,
// and the name and path guards of core/docs-fs.ts.
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentFolderIds, agentMay, agentMayFor, approvalNeeded, cleanFolderAccess, effectiveAccess, mayApprove, personMay, visibleFolderIds, type Who } from '../src/shared/doc-access'
import { acceptsDoc, DOC_EXTENSIONS, docKind, folderPath, folderPathWithin, noAccess, parseActor, type DocFolder, type FolderAccess } from '../src/shared/docs'
import { cleanFileName, cleanName, isInside, looseName, plain, safeJoin, uniqueName } from '../src/core/docs-fs'

type Lite = Pick<DocFolder, 'id' | 'parentId' | 'access' | 'privateTo'>

const acc = (p: Partial<FolderAccess> = {}): FolderAccess => ({ people: {}, sectors: {}, agents: {}, ...p })
const dir = (id: string, parentId: string | null, access: FolderAccess | null, privateTo: string | null = null): Lite => ({ id, parentId, access, privateTo })
const who = (id: string, role: Who['role'] = 'member'): Who => ({ id, role })
const sorted = (s: Set<string>): string[] => [...s].sort()

const ana = who('ana', 'owner')
const adm = who('adm', 'admin')
const maria = who('maria')
const pedro = who('pedro')
const lia = who('lia')

// Two sectors: the head `fin` with `fina` below it, the head `tec` with `bia` below it, and `solo`, in neither.
const AGENTS = [{ id: 'fin' }, { id: 'fina', reportsTo: 'fin' }, { id: 'tec' }, { id: 'bia', reportsTo: 'tec' }, { id: 'solo' }]
const fin = { id: 'fin' }
const fina = { id: 'fina' }
const bia = { id: 'bia' }
const solo = { id: 'solo' }

const FOLDERS: Lite[] = [
  dir('company', null, acc({ everyone: 'view', allAgents: 'read' })),
  dir('fin', null, acc({ people: { maria: 'edit', pedro: 'view' }, sectors: { fin: 'write' } })),
  dir('fin-sub', 'fin', null),
  dir('fin-deep', 'fin-sub', null),
  dir('tec', null, acc({ sectors: { tec: 'read' } })),
  dir('open', null, acc({ everyone: 'edit' })),
  dir('mine', null, acc({ everyone: 'edit', allAgents: 'write' }), 'maria'),
  dir('mine-sub', 'mine', null),
  dir('bare', null, null)
]

describe('personMay', () => {
  it('lets the owner and an admin see and edit every shared folder, even one with nothing set', () => {
    for (const p of [ana, adm]) for (const id of ['company', 'fin', 'fin-deep', 'tec', 'open', 'bare']) for (const need of ['view', 'edit'] as const) expect(personMay(p, FOLDERS, id, need)).toBe(true)
  })

  it('gives a member only what people[id] or everyone says', () => {
    expect(personMay(maria, FOLDERS, 'fin', 'view')).toBe(true)
    expect(personMay(lia, FOLDERS, 'fin', 'view')).toBe(false)
    expect(personMay(lia, FOLDERS, 'tec', 'view')).toBe(false)
    expect(personMay(lia, FOLDERS, 'bare', 'view')).toBe(false)
    expect(personMay(lia, FOLDERS, 'company', 'view')).toBe(true)
    expect(personMay(lia, FOLDERS, 'open', 'edit')).toBe(true)
  })

  it('takes edit as view too, and view as not enough to edit', () => {
    expect(personMay(maria, FOLDERS, 'fin', 'edit')).toBe(true)
    expect(personMay(pedro, FOLDERS, 'fin', 'view')).toBe(true)
    expect(personMay(pedro, FOLDERS, 'fin', 'edit')).toBe(false)
    expect(personMay(lia, FOLDERS, 'company', 'edit')).toBe(false)
  })

  it('takes the best of everyone and the person\'s own level', () => {
    const folders = [dir('x', null, acc({ everyone: 'view', people: { maria: 'edit' } }))]
    expect(personMay(maria, folders, 'x', 'edit')).toBe(true)
    expect(personMay(lia, folders, 'x', 'edit')).toBe(false)
    expect(personMay(lia, folders, 'x', 'view')).toBe(true)
  })

  it('lets a folder with access null follow the nearest ancestor that has one', () => {
    expect(personMay(maria, FOLDERS, 'fin-deep', 'edit')).toBe(true)
    expect(personMay(lia, FOLDERS, 'fin-deep', 'view')).toBe(false)
    const own = [...FOLDERS, dir('fin-own', 'fin', acc({ people: { lia: 'view' } }))]
    // its own access wins over the parent's: maria, who edits the parent, is not in it
    expect(personMay(lia, own, 'fin-own', 'view')).toBe(true)
    expect(personMay(maria, own, 'fin-own', 'view')).toBe(false)
  })

  it('keeps a personal folder to its person: not the owner, not an admin, not anyone it is shared with by mistake', () => {
    expect(personMay(maria, FOLDERS, 'mine', 'edit')).toBe(true)
    for (const p of [ana, adm, pedro, lia]) for (const need of ['view', 'edit'] as const) expect(personMay(p, FOLDERS, 'mine', need)).toBe(false)
  })

  it('makes a subfolder under a personal root personal too', () => {
    expect(personMay(maria, FOLDERS, 'mine-sub', 'edit')).toBe(true)
    expect(personMay(ana, FOLDERS, 'mine-sub', 'view')).toBe(false)
    expect(personMay(lia, FOLDERS, 'mine-sub', 'view')).toBe(false)
  })

  it('refuses a folder id that is not there, whoever asks', () => {
    expect(personMay(ana, FOLDERS, 'nope', 'view')).toBe(false)
    expect(personMay(maria, FOLDERS, 'nope', 'edit')).toBe(false)
  })

  it('does not loop on folders that point at each other', () => {
    const loop = [dir('a', 'b', null), dir('b', 'a', null)]
    expect(personMay(lia, loop, 'a', 'view')).toBe(false)
    expect(effectiveAccess(loop, 'a')).toEqual({ access: noAccess(), privateTo: null })
  })
})

describe('agentMay', () => {
  it('lets an agent in through its sector\'s head, its own id, or allAgents', () => {
    expect(agentMay(fina, AGENTS, FOLDERS, 'fin', 'write')).toBe(true)
    expect(agentMay(fin, AGENTS, FOLDERS, 'fin', 'write')).toBe(true) // the head is in its own sector
    expect(agentMay(bia, AGENTS, FOLDERS, 'fin', 'read')).toBe(false)
    expect(agentMay(bia, AGENTS, FOLDERS, 'tec', 'read')).toBe(true)
    expect(agentMay(solo, AGENTS, FOLDERS, 'company', 'read')).toBe(true) // allAgents
    expect(agentMay(solo, AGENTS, FOLDERS, 'fin', 'read')).toBe(false) // in no sector
    const byId = [dir('x', null, acc({ agents: { solo: 'write' } }))]
    expect(agentMay(solo, AGENTS, byId, 'x', 'write')).toBe(true)
    expect(agentMay(fina, AGENTS, byId, 'x', 'read')).toBe(false)
  })

  it('takes write as read, and read as not enough to write', () => {
    expect(agentMay(fina, AGENTS, FOLDERS, 'fin', 'read')).toBe(true)
    expect(agentMay(bia, AGENTS, FOLDERS, 'tec', 'write')).toBe(false)
    expect(agentMay(fina, AGENTS, FOLDERS, 'company', 'write')).toBe(false)
  })

  it('takes the best level of the ways in', () => {
    const folders = [dir('x', null, acc({ allAgents: 'read', agents: { bia: 'write' }, sectors: { tec: 'read' } }))]
    expect(agentMay(bia, AGENTS, folders, 'x', 'write')).toBe(true)
    expect(agentMay(fina, AGENTS, folders, 'x', 'write')).toBe(false)
    expect(agentMay(fina, AGENTS, folders, 'x', 'read')).toBe(true)
  })

  it('never opens a personal folder by the folder\'s own rule, however wide its access is set', () => {
    expect(agentMay(fina, AGENTS, FOLDERS, 'mine', 'read')).toBe(false)
    expect(agentMay(fina, AGENTS, FOLDERS, 'mine-sub', 'read')).toBe(false)
  })

  it('refuses a folder id that is not there', () => {
    expect(agentMay(fina, AGENTS, FOLDERS, 'nope', 'read')).toBe(false)
  })
})

describe('agentMayFor', () => {
  it('works for one person as the intersection: the agent may and the person may', () => {
    expect(agentMayFor(fina, AGENTS, maria, FOLDERS, 'fin', 'write')).toBe(true)
    // the agent is allowed, the person is not: asking an agent is not a way around the folder
    expect(agentMayFor(fina, AGENTS, lia, FOLDERS, 'fin', 'read')).toBe(false)
    // the person is allowed, the agent is not
    expect(agentMayFor(bia, AGENTS, maria, FOLDERS, 'fin', 'read')).toBe(false)
    // both may read, only the person may not write
    expect(agentMayFor(fina, AGENTS, pedro, FOLDERS, 'fin', 'read')).toBe(true)
    expect(agentMayFor(fina, AGENTS, pedro, FOLDERS, 'fin', 'write')).toBe(false)
  })

  it('counts the owner as a person too: the agent still has to be allowed', () => {
    expect(agentMayFor(fina, AGENTS, ana, FOLDERS, 'fin', 'write')).toBe(true)
    expect(agentMayFor(bia, AGENTS, ana, FOLDERS, 'fin', 'read')).toBe(false)
  })

  it('opens a person\'s own personal folder to their agent, and no one else\'s', () => {
    expect(agentMayFor(bia, AGENTS, maria, FOLDERS, 'mine', 'write')).toBe(true)
    expect(agentMayFor(bia, AGENTS, maria, FOLDERS, 'mine-sub', 'read')).toBe(true)
    expect(agentMayFor(fina, AGENTS, pedro, FOLDERS, 'mine', 'read')).toBe(false)
    expect(agentMayFor(fina, AGENTS, ana, FOLDERS, 'mine', 'read')).toBe(false)
    expect(agentMayFor(fina, AGENTS, maria, FOLDERS, 'nope', 'read')).toBe(false)
  })

  it('needs every reader of a channel to be allowed', () => {
    expect(agentMayFor(fina, AGENTS, [maria, pedro], FOLDERS, 'fin', 'read')).toBe(true)
    expect(agentMayFor(fina, AGENTS, [maria, pedro], FOLDERS, 'fin', 'write')).toBe(false) // pedro only views
    expect(agentMayFor(fina, AGENTS, [maria, lia], FOLDERS, 'fin', 'read')).toBe(false) // lia is an outsider
    expect(agentMayFor(bia, AGENTS, [maria, pedro], FOLDERS, 'fin', 'read')).toBe(false) // the agent itself is not allowed
  })

  it('never opens a personal folder in a channel, even to the person it belongs to', () => {
    expect(agentMayFor(bia, AGENTS, [maria, pedro], FOLDERS, 'mine', 'read')).toBe(false)
    expect(agentMayFor(bia, AGENTS, [maria, ana], FOLDERS, 'mine-sub', 'read')).toBe(false)
  })

  it('treats a list of one like that one person', () => {
    expect(agentMayFor(bia, AGENTS, [maria], FOLDERS, 'mine', 'read')).toBe(true)
    expect(agentMayFor(fina, AGENTS, [lia], FOLDERS, 'fin', 'read')).toBe(false)
  })

  it('gives an agent working for no one (a routine) only what the agent itself may', () => {
    for (const requester of [null, undefined, []]) {
      expect(agentMayFor(fina, AGENTS, requester, FOLDERS, 'fin', 'write')).toBe(true)
      expect(agentMayFor(bia, AGENTS, requester, FOLDERS, 'fin', 'read')).toBe(false)
      expect(agentMayFor(fina, AGENTS, requester, FOLDERS, 'mine', 'read')).toBe(false)
    }
  })
})

describe('approvalNeeded and mayApprove', () => {
  const ap = (id: string, parentId: string | null, needsApproval: boolean, privateTo: string | null = null) => ({ id, parentId, needsApproval, privateTo })
  const APPROVAL = [ap('root', null, true), ap('child', 'root', false), ap('grand', 'child', false), ap('plain', null, false), ap('plain-child', 'plain', false), ap('mine', null, true, 'maria'), ap('mine-sub', 'mine', false)]

  it('asks for approval where the folder or one above it asks, and a subfolder cannot switch it off', () => {
    expect(approvalNeeded(APPROVAL, 'root')).toBe(true)
    expect(approvalNeeded(APPROVAL, 'child')).toBe(true)
    expect(approvalNeeded(APPROVAL, 'grand')).toBe(true)
    expect(approvalNeeded(APPROVAL, 'plain')).toBe(false)
    expect(approvalNeeded(APPROVAL, 'plain-child')).toBe(false)
  })

  it('never asks in a personal folder, whatever its flag says, nor in one that is not there', () => {
    expect(approvalNeeded(APPROVAL, 'mine')).toBe(false)
    expect(approvalNeeded(APPROVAL, 'mine-sub')).toBe(false)
    expect(approvalNeeded(APPROVAL, 'nope')).toBe(false)
  })

  it('lets the owner, an admin and whoever may edit the folder approve, and no one who only views', () => {
    expect(mayApprove(ana, FOLDERS, 'fin')).toBe(true)
    expect(mayApprove(adm, FOLDERS, 'tec')).toBe(true)
    expect(mayApprove(maria, FOLDERS, 'fin-deep')).toBe(true)
    expect(mayApprove(maria, FOLDERS, 'open')).toBe(true)
    expect(mayApprove(pedro, FOLDERS, 'fin')).toBe(false)
    expect(mayApprove(lia, FOLDERS, 'company')).toBe(false)
    expect(mayApprove(lia, FOLDERS, 'fin')).toBe(false)
  })

  it('lets no one approve in a personal folder, its own person included, or in a folder that is not there', () => {
    for (const p of [ana, adm, maria]) expect(mayApprove(p, FOLDERS, 'mine')).toBe(false)
    expect(mayApprove(maria, FOLDERS, 'mine-sub')).toBe(false)
    expect(mayApprove(ana, FOLDERS, 'nope')).toBe(false)
  })
})

describe('what a person or an agent sees', () => {
  it('lists the folders a person sees, personal ones only for their person', () => {
    expect(sorted(visibleFolderIds(ana, FOLDERS))).toEqual(['bare', 'company', 'fin', 'fin-deep', 'fin-sub', 'open', 'tec'])
    expect(sorted(visibleFolderIds(maria, FOLDERS))).toEqual(['company', 'fin', 'fin-deep', 'fin-sub', 'mine', 'mine-sub', 'open'])
    expect(sorted(visibleFolderIds(pedro, FOLDERS))).toEqual(['company', 'fin', 'fin-deep', 'fin-sub', 'open'])
    expect(sorted(visibleFolderIds(lia, FOLDERS))).toEqual(['company', 'open'])
  })

  it('lists the folders an agent may use for a requester', () => {
    expect(sorted(agentFolderIds(fina, AGENTS, null, FOLDERS, 'read'))).toEqual(['company', 'fin', 'fin-deep', 'fin-sub'])
    expect(sorted(agentFolderIds(fina, AGENTS, null, FOLDERS, 'write'))).toEqual(['fin', 'fin-deep', 'fin-sub'])
    expect(sorted(agentFolderIds(bia, AGENTS, null, FOLDERS, 'read'))).toEqual(['company', 'tec'])
    expect(sorted(agentFolderIds(fina, AGENTS, maria, FOLDERS, 'read'))).toEqual(['company', 'fin', 'fin-deep', 'fin-sub', 'mine', 'mine-sub'])
    expect(sorted(agentFolderIds(fina, AGENTS, lia, FOLDERS, 'read'))).toEqual(['company'])
  })

  it('lists for a channel only what every reader may, and never a personal folder', () => {
    expect(sorted(agentFolderIds(fina, AGENTS, [maria, pedro], FOLDERS, 'read'))).toEqual(['company', 'fin', 'fin-deep', 'fin-sub'])
    expect(sorted(agentFolderIds(fina, AGENTS, [maria, pedro], FOLDERS, 'write'))).toEqual([])
  })
})

describe('cleanFolderAccess', () => {
  it('drops the people, agents and levels that do not exist, and keeps allAgents', () => {
    const out = cleanFolderAccess(
      { everyone: 'edit', allAgents: 'write', people: { maria: 'edit', ghost: 'view', pedro: 'owner' }, sectors: { fin: 'read', zzz: 'write' }, agents: { bia: 'write', fina: 'bogus' } },
      ['maria', 'pedro'],
      ['fin', 'fina', 'bia']
    )
    expect(out).toEqual({ everyone: 'edit', allAgents: 'write', people: { maria: 'edit' }, sectors: { fin: 'read' }, agents: { bia: 'write' } })
  })

  it('drops an everyone or allAgents it does not know', () => {
    const out = cleanFolderAccess({ everyone: 'write', allAgents: 'edit', people: {}, sectors: {}, agents: {} }, [], [])
    expect(out).toEqual(noAccess())
  })

  it('reads anything that is not an access as no access at all', () => {
    for (const bad of [null, undefined, 'x', 42, [], { people: 'maria', sectors: 3, agents: null }]) expect(cleanFolderAccess(bad, ['maria'], ['fin'])).toEqual(noAccess())
  })
})

describe('folder paths', () => {
  const tree = [
    { id: 'a', parentId: null, name: 'Financeiro' },
    { id: 'b', parentId: 'a', name: 'Contratos' },
    { id: 'c', parentId: 'b', name: 'Assinados' }
  ]

  it('names the folders from the root down', () => {
    expect(folderPath(tree, 'c')).toEqual(['Financeiro', 'Contratos', 'Assinados'])
    expect(folderPath(tree, 'a')).toEqual(['Financeiro'])
    expect(folderPath(tree, null)).toEqual([])
    expect(folderPath(tree, 'nope')).toEqual([])
  })

  it('leaves out the name of an ancestor the reader may not use: the path starts at the nearest reachable one', () => {
    expect(folderPathWithin(tree, 'c', new Set(['b', 'c']))).toEqual(['Contratos', 'Assinados'])
    expect(folderPathWithin(tree, 'c', new Set(['a', 'c']))).toEqual(['Assinados']) // b hides a, even though a is allowed
    expect(folderPathWithin(tree, 'c', new Set())).toEqual([])
    expect(folderPathWithin(tree, 'c', new Set(['a', 'b', 'c']))).toEqual(['Financeiro', 'Contratos', 'Assinados'])
  })

  it('does not loop on folders that point at each other', () => {
    const loop = [{ id: 'a', parentId: 'b', name: 'A' }, { id: 'b', parentId: 'a', name: 'B' }]
    expect(folderPath(loop, 'a')).toEqual(['B', 'A'])
    expect(folderPathWithin(loop, 'a', new Set(['a', 'b']))).toEqual(['B', 'A'])
  })
})

describe('which files Documentos takes', () => {
  it('takes PDFs, Word, spreadsheets, text, web pages and pictures, by their extension in any case', () => {
    expect(docKind('a.pdf')).toBe('pdf')
    expect(docKind('a.docx')).toBe('docx')
    expect(docKind('a.xlsx')).toBe('xlsx')
    expect(docKind('a.csv')).toBe('csv')
    expect(docKind('a.md')).toBe('markdown')
    expect(docKind('a.markdown')).toBe('markdown')
    expect(docKind('a.txt')).toBe('text')
    expect(docKind('a.json')).toBe('text')
    expect(docKind('a.html')).toBe('html')
    expect(docKind('a.htm')).toBe('html')
    expect(docKind('a.png')).toBe('image')
    expect(docKind('FOTO.JPG')).toBe('image')
    expect(docKind('Relatório Final.PDF')).toBe('pdf')
  })

  it('takes every extension it lists', () => {
    for (const ext of DOC_EXTENSIONS) expect(acceptsDoc(`arquivo${ext}`)).toBe(true)
  })

  it('refuses video, audio, archives, vector images, programs and names with no real extension', () => {
    for (const name of ['v.mp4', 'a.mp3', 'a.zip', 'logo.svg', 'setup.exe', 'script.js', 'README', '.pdf', 'pdf', 'a.', 'a.pdf.exe']) {
      expect(acceptsDoc(name)).toBe(false)
      expect(docKind(name)).toBeNull()
    }
  })

  it('tells people and agents apart in an actor', () => {
    expect(parseActor('person:ana')).toEqual({ kind: 'person', id: 'ana' })
    expect(parseActor('agent:fina')).toEqual({ kind: 'agent', id: 'fina' })
    expect(parseActor('outside')).toEqual({ kind: 'outside', id: '' })
    expect(parseActor('system')).toEqual({ kind: 'outside', id: '' })
  })
})

describe('names and paths on disk', () => {
  it('keeps what an agent will read inside an instruction plain: no @, quotes, backticks, brackets or line breaks', () => {
    const out = plain('@all "ignore" `rm -rf` <b>[x]{y}\r\nnext\u2028line', 200)
    expect(out).not.toMatch(/[@"`<>[\]{}\r\n\u2028]/)
    expect(out).toBe('all ignore rm -rf bxy next line')
  })

  it('squeezes spaces and cuts at the limit', () => {
    expect(plain('  a   b  ', 50)).toBe('a b')
    expect(plain('x'.repeat(100), 10)).toHaveLength(10)
  })

  it('turns separators and dots in a file name into something a folder can hold', () => {
    expect(cleanFileName('../x.md')).toBe('-x.md')
    expect(cleanFileName('a/b.md')).toBe('a-b.md')
    expect(cleanFileName('a\\b.md')).toBe('a-b.md')
    expect(cleanFileName('.hidden.md')).toBe('hidden.md')
    expect(cleanFileName('/etc/passwd.txt')).toBe('-etc-passwd.txt')
    expect(cleanFileName('..')).toBe('')
    expect(cleanName('  .. ')).toBe('')
  })

  it('cuts a long name without eating the extension', () => {
    const out = cleanFileName(`${'a'.repeat(300)}.pdf`)
    expect(out.endsWith('.pdf')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(130)
  })

  it('refuses a path that leads out of the root, or is the root itself', () => {
    // Built with the system's own separators: on Windows the root is D:\data\docs, not /data/docs.
    const root = resolve('/data/docs')
    expect(safeJoin(root, 'Financeiro', 'a.md')).toBe(join(root, 'Financeiro', 'a.md'))
    expect(() => safeJoin(root, '..', 'x.md')).toThrow()
    expect(() => safeJoin(root, 'a', '..', '..', 'x')).toThrow()
    expect(() => safeJoin(root)).toThrow()
    expect(isInside(root, resolve('/data/docs-other/x'))).toBe(false)
    expect(isInside(root, join(root, 'a', 'b'))).toBe(true)
  })

  it('finds a folder by what someone typed: no case, no accents', () => {
    expect(looseName('  Relatórios   Anuais ')).toBe('relatorios anuais')
    expect(looseName('RELATORIOS ANUAIS')).toBe(looseName('Relatórios anuais'))
  })

  it('numbers a name that is taken, keeping its extension', () => {
    const taken = new Set(['a.md', 'a (2).md'])
    expect(uniqueName('b.md', (n) => taken.has(n))).toBe('b.md')
    expect(uniqueName('a.md', (n) => taken.has(n))).toBe('a (3).md')
    expect(uniqueName('pasta', (n) => n === 'pasta')).toBe('pasta (2)')
  })
})
