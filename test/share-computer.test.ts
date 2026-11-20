// A computer lent to a server (docs/local-node.md) goes to the agents its person picks, in one call: they
// may pick even without being an admin, since an agent reaches the computer only when working for them.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { shareComputer } from '../src/core/people'
import { nodeUrl } from '../src/shared/node-link'
import type { Agent, Person } from '../src/shared/types'

const roots: string[] = []
afterAll(() => roots.forEach((r) => { try { rmSync(r, { recursive: true, force: true }) } catch {} }))

const agent = (id: string, p: Partial<Agent> = {}): Agent => ({ id, name: id, handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...p })

// Ana owns the Tucano; Bia and Caio are members. Bia lent her iMac; Ana lent her MacBook (no owner in its address).
function team(): { db: Db; ana: Person; bia: Person; caio: Person } {
  const d = mkdtempSync(join(tmpdir(), 'tucano-share-'))
  roots.push(d)
  const db = new Db(join(d, 'tucano.db'))
  const ana = db.person(db.ownerId())!
  const bia: Person = { id: 'bia', name: 'Bia', role: 'member', about: '' }
  const caio: Person = { id: 'caio', name: 'Caio', role: 'member', about: '' }
  db.addPerson(bia)
  db.addPerson(caio)
  for (const a of [agent('lia'), agent('rui', { grants: { other: 'read' } }), agent('old', { archived: true }), agent('tuca', { kind: 'tuca' })]) db.saveAgent(a)
  db.saveConnector({ id: 'imac', name: 'iMac · computador de Bia', kind: 'remote', url: nodeUrl('dev-bia', 'bia'), auth: 'none' })
  db.saveConnector({ id: 'mbp', name: 'MacBook de Ana', kind: 'remote', url: nodeUrl('dev-ana'), auth: 'none' })
  db.saveConnector({ id: 'other', name: 'Linear', kind: 'remote', url: 'https://mcp.linear.app/mcp', auth: 'none' })
  return { db, ana, bia, caio }
}
const has = (db: Db, id: string, c: string): string | undefined => db.agent(id)!.grants[c]

describe('shareComputer', () => {
  it("a member gives her own computer to the agents she picks, to read and write, and nothing else changes", () => {
    const { db, bia } = team()
    const changed = shareComputer(db, bia, 'imac', ['lia', 'rui'])
    expect(changed.map((a) => a.id).sort()).toEqual(['lia', 'rui'])
    expect(has(db, 'lia', 'imac')).toBe('read_write')
    expect(has(db, 'rui', 'imac')).toBe('read_write')
    expect(has(db, 'rui', 'other')).toBe('read') // its other connectors stay as they were
    expect(has(db, 'old', 'imac')).toBeUndefined() // archived and the Tuca are left out
    expect(has(db, 'tuca', 'imac')).toBeUndefined()
  })

  it('is the exact set: one left out loses it, and the same set again changes nothing', () => {
    const { db, bia } = team()
    shareComputer(db, bia, 'imac', ['lia', 'rui'])
    expect(shareComputer(db, bia, 'imac', ['lia']).map((a) => a.id)).toEqual(['rui'])
    expect(has(db, 'rui', 'imac')).toBeUndefined()
    expect(shareComputer(db, bia, 'imac', ['lia'])).toEqual([])
    shareComputer(db, bia, 'imac', [])
    expect(has(db, 'lia', 'imac')).toBeUndefined()
  })

  it("someone else's computer isn't a member's to give; an admin's word goes, as with any connector", () => {
    const { db, ana, caio } = team()
    expect(() => shareComputer(db, caio, 'imac', ['lia'])).toThrow('Só quem emprestou o computador')
    expect(() => shareComputer(db, caio, 'mbp', ['lia'])).toThrow('Só quem emprestou o computador')
    expect(has(db, 'lia', 'imac')).toBeUndefined()
    shareComputer(db, ana, 'imac', ['lia'])
    expect(has(db, 'lia', 'imac')).toBe('read_write')
    shareComputer(db, ana, 'mbp', ['rui']) // the owner's own (no owner in its address)
    expect(has(db, 'rui', 'mbp')).toBe('read_write')
  })

  it('only lent computers: any other connector stays an admin’s, on the agent page', () => {
    const { db, ana } = team()
    expect(() => shareComputer(db, ana, 'other', ['lia'])).toThrow('Isso não é um computador emprestado')
    expect(() => shareComputer(db, ana, 'nope', ['lia'])).toThrow('Isso não é um computador emprestado')
  })

  it('someone who sees part of the team touches only that part', () => {
    const { db } = team()
    db.saveAgent(agent('lia', { grants: { imac: 'read_write' } }))
    const bia: Person = { id: 'bia', name: 'Bia', role: 'member', about: '', access: { mode: 'picked', sectors: [], agents: ['rui'], channels: [] } }
    shareComputer(db, bia, 'imac', ['rui'])
    expect(has(db, 'rui', 'imac')).toBe('read_write')
    expect(has(db, 'lia', 'imac')).toBe('read_write') // not hers to see, so not taken by leaving it out
  })
})
