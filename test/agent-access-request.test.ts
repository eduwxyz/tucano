// An agent asks for the access it lacks (a computer for a shell, a browser, folders) on a
// propor_ajuste card, and the person approves it right there in the chat. These always wait for a click:
// they never go in by themselves, not even with the Tuca's "apply right away".
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { folderToLend } from '../src/core/computer'
import { changedSince, splitChange } from '../src/core/tuca-apply'
import { proposalFrom, PROPOR_AJUSTE } from '../src/core/tuca-help'
import { setLang } from '../src/shared/lang'
import { onlyAccessChanges, type Agent, type Proposal } from '../src/shared/types'

setLang('pt')
const agent = (extra: Partial<Agent> = {}): Agent => ({ id: 'a1', name: 'Dev', handle: 'dev', role: '', color: 'sky', instructions: 'Você programa.', modelId: 'sonnet', effort: 'low', limit: 100_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })

let home = ''
let data = ''
let project = ''
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'access-home-')))
  data = join(home, 'Library', 'Tucano')
  mkdirSync(data, { recursive: true })
  project = join(home, 'Workspace', 'social-posts')
  mkdirSync(project, { recursive: true })
  mkdirSync(join(home, '.ssh'))
})
const ctxFor = (a: Agent) => ({ agents: [a], conversations: [], connectors: [], usable: () => true, folder: (p: string) => folderToLend(p, data, home) })
const ask = (a: Agent, args: Record<string, unknown>) => proposalFrom('propor_ajuste', { agente: 'dev', ...args }, ctxFor(a))

describe('an agent asks for a computer, a browser and folders on a card', () => {
  it('the tool says how, and that it waits for the person', () => {
    const props = (PROPOR_AJUSTE.inputSchema as { properties: Record<string, unknown> }).properties
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['computador', 'navegador', 'pastas']))
    expect(PROPOR_AJUSTE.description).toMatch(/computador, navegador e pastas sempre esperam/)
  })

  it('a computer, a browser and a folder, read-only unless asked to write', () => {
    const r = ask(agent(), { computador: 'linux', navegador: true, pastas: [{ caminho: '~/Workspace/social-posts' }], motivo: 'Gerar as artes' })
    expect(r.error).toBeUndefined()
    expect(r.proposal).toEqual({
      kind: 'agent',
      agentId: 'a1',
      changes: { computer: true, browser: true, folders: [{ name: 'social-posts', path: project, readOnly: true }] },
      before: { computer: false, browser: undefined, folders: undefined },
      reason: 'Gerar as artes'
    })
    const w = ask(agent(), { computador: 'linux', pastas: [{ caminho: project, escrita: true }] })
    expect(w.proposal?.kind === 'agent' && w.proposal.changes.folders?.[0]?.readOnly).toBe(false)
  })

  it('only what differs: an agent that already has it gets "nothing would change"', () => {
    const has = agent({ computer: true, browser: true, folders: [{ name: 'social-posts', path: project, readOnly: true }] })
    expect(ask(has, { computador: 'linux', navegador: true, pastas: [{ caminho: project }] }).error).toContain('Nada mudaria')
    // The same folder, now to write: only its mode changes.
    const r = ask(has, { pastas: [{ caminho: project, escrita: true }] })
    expect(r.proposal?.kind === 'agent' && r.proposal.changes).toEqual({ folders: [{ name: 'social-posts', path: project, readOnly: false }] })
  })

  it('moving to this Mac, or taking the computer away', () => {
    expect(ask(agent({ computer: true }), { computador: 'mac' }).proposal).toMatchObject({ changes: { computerKind: 'mac' } })
    expect(ask(agent(), { computador: 'mac' }).proposal).toMatchObject({ changes: { computer: true, computerKind: 'mac' } })
    expect(ask(agent({ computer: true }), { computador: 'nenhum' }).proposal).toMatchObject({ changes: { computer: false } })
    expect(ask(agent(), { computador: 'windows' }).error).toMatch(/linux/)
  })

  it('refuses folders it could never lend, and folders without a computer', () => {
    expect(ask(agent(), { pastas: [{ caminho: project }] }).error).toMatch(/computador/)
    expect(ask(agent(), { computador: 'linux', pastas: [{ caminho: '~/.ssh' }] }).error).toMatch(/credenciais/)
    expect(ask(agent(), { computador: 'linux', pastas: [{ caminho: '~/nao-existe' }] }).error).toMatch(/não existe/)
    expect(ask(agent(), { computador: 'linux', pastas: [{ caminho: '~' }] }).error).toBeDefined()
    expect(ask(agent(), { computador: 'linux', pastas: [{ caminho: 'Workspace/x' }] }).error).toMatch(/caminho inteiro/)
    expect(ask(agent(), { computador: 'linux', pastas: [{ caminho: data }] }).error).toBeDefined()
  })
})

describe('these always wait for a click', () => {
  it('a change with a name and a computer splits: the name goes in, the computer waits on its card', () => {
    const p = { kind: 'agent', agentId: 'a1', changes: { name: 'Dev 2', computer: true, browser: true }, before: { name: 'Dev', computer: false, browser: false } } as Extract<Proposal, { kind: 'agent' }>
    const { inside, access } = splitChange(p)
    expect(inside?.changes).toEqual({ name: 'Dev 2' })
    expect(access?.changes).toEqual({ computer: true, browser: true })
    expect(onlyAccessChanges({ computer: true, computerKind: 'mac', folders: [] })).toBe(true)
    expect(onlyAccessChanges({ computer: true, web: false })).toBe(false)
  })

  it('Desfazer sees a computer or folder changed since, read the way the agent stores them', () => {
    const now = agent({ computer: true, browser: true })
    expect(changedSince(now, { computer: true, browser: true, computerKind: 'linux', folders: [] })).toEqual([])
    expect(changedSince(now, { computerKind: 'mac' })).toEqual(['computerKind'])
  })
})

describe('only the computers that exist where the app runs', () => {
  const on = (a: Agent, machine: { linux: boolean; here: 'mac' | 'computer' | 'server' }, args: Record<string, unknown>) => proposalFrom('propor_ajuste', { agente: 'dev', ...args }, { ...ctxFor(a), machine })
  const pro = { linux: false, here: 'server' as const }

  it('on a server without Docker (Tucano Pro), an isolated Linux is refused and says what there is', () => {
    const r = on(agent(), pro, { computador: 'linux' })
    expect(r.proposal).toBeUndefined()
    expect(r.error).toMatch(/não tem Linux isolado/)
    expect(r.error).toMatch(/direto no servidor/)
  })

  it('on that server, the computer right on it can be asked for', () => {
    const r = on(agent(), pro, { computador: 'mac', motivo: 'Rodar os scripts' })
    expect(r.error).toBeUndefined()
    expect((r.proposal as Extract<Proposal, { kind: 'agent' }>).changes).toEqual({ computer: true, computerKind: 'mac' })
  })

  it('on that server, folders are refused: they go to an isolated Linux', () => {
    const r = on(agent({ computer: true, computerKind: 'mac' }), pro, { pastas: [{ caminho: '~/Workspace/social-posts' }] })
    expect(r.proposal).toBeUndefined()
    expect(r.error).toMatch(/não dá pra emprestar pastas/)
  })

  it('right on the computer, folders are not asked for: the agent already reaches them', () => {
    const r = on(agent({ computer: true, computerKind: 'mac' }), { linux: true, here: 'mac' }, { pastas: [{ caminho: '~/Workspace/social-posts' }] })
    expect(r.proposal).toBeUndefined()
    expect(r.error).toMatch(/já alcança/)
    // Asking for the isolated Linux with them is fine.
    expect(on(agent({ computer: true, computerKind: 'mac' }), { linux: true, here: 'mac' }, { computador: 'linux', pastas: [{ caminho: '~/Workspace/social-posts' }] }).error).toBeUndefined()
  })
})
