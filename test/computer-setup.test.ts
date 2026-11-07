import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Agent, Settings } from '../src/shared/types'
import { SETUP_PRESETS } from '../src/shared/computer-setup'
import { baseTag, Computers } from '../src/core/computer'
import { systemPrompt } from '../src/core/context'
import { Db } from '../src/core/db'

const ready = { installed: true, loggedIn: true }
const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, gemini: ready, cursor: ready, grok: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
// Ids that start apart: a computer's name is the first 8 characters of its agent's id.
const agent = (id: string, handle: string): Agent => ({ id, name: handle, handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: true, archived: false })
const script = (...markers: string[]): string => SETUP_PRESETS().filter((p) => markers.includes(p.marker)).map((p) => p.script).join('\n\n')

describe('the agents’ computer setup', () => {
  it('names its base after the script: the same script, the same base; another, another', () => {
    expect(baseTag('apt-get install -y jq')).toBe(baseTag('  apt-get install -y jq\n'))
    expect(baseTag('apt-get install -y jq')).not.toBe(baseTag('apt-get install -y unzip'))
    expect(baseTag('x')).toMatch(/^tucano-base:[0-9a-f]{12}$/)
  })

  it('tells the agent what its computer already has, so it uses it instead of installing again', () => {
    const lia = agent('a1', 'lia')
    const conv = { id: 'd', kind: 'dm' as const, name: 'a1', members: ['a1'] }
    const setup = script('# glab', '# databricks')
    const prompt = systemPrompt({ agent: lia, settings, conversation: conv, peers: [], hasComputer: true, computerSetup: setup })
    expect(prompt).toContain('O computador já vem preparado por Edu')
    expect(prompt).toContain('gitlab-org%2Fcli/releases')
    expect(systemPrompt({ agent: lia, settings, conversation: conv, peers: [], hasComputer: true })).not.toContain('já vem preparado')
  })
})

// Builds a real base with the presets and starts two computers from it: needs Docker and the base image.
const hasDocker = ((): boolean => {
  try {
    execFileSync('docker', ['image', 'inspect', 'node:22-bookworm'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!hasDocker)('the agents’ computer setup (Docker)', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tucano-setup-'))
  const db = new Db(join(dataDir, 'test.db'))
  const lia = agent('5e7a0001-0000-4000-8000-000000000001', 'lia')
  const theo = agent('5e7a0002-0000-4000-8000-000000000002', 'theo')
  db.saveAgent(lia)
  db.saveAgent(theo)
  let setup = script('# básicas', '# glab', '# databricks')
  const computers = new Computers({ db, dataDir, emit: () => {}, setup: () => setup })
  const ctx = { conversationId: 'd', messageId: 'm' }
  const bash = async (a: Agent, command: string): Promise<string> => {
    const out = await computers.call(a, 'bash', { command }, ctx)
    return out.result.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
  }

  afterAll(async () => {
    await computers.erase(lia.id)
    await computers.erase(theo.id)
    try {
      execFileSync('docker', ['image', 'rm', baseTag(script('# básicas', '# glab', '# databricks'))], { stdio: 'ignore' })
    } catch {
      /* already gone */
    }
  }, 120_000)

  it('a new computer comes with what the setup installs; the next one starts from the same base, at once', async () => {
    await computers.ensure(lia.id)
    const said = await bash(lia, 'glab --version | head -1 && databricks --version && jq --version')
    expect(said).toMatch(/glab \d+\.\d+/)
    expect(said).toMatch(/Databricks CLI v\d+/)
    expect(said).toMatch(/jq-1\.\d/)

    const t0 = Date.now()
    await computers.ensure(theo.id)
    expect(Date.now() - t0).toBeLessThan(60_000) // no new install: the base is there
    expect(await bash(theo, 'glab --version | head -1')).toMatch(/glab \d+\.\d+/)
  }, 900_000)

  it('a setup that fails says so, with what it said, and the computer doesn’t start', async () => {
    setup = 'echo "baixando ferramenta"\nexit 7'
    const nina = agent('5e7a0003-0000-4000-8000-000000000003', 'nina')
    db.saveAgent(nina)
    const out = await computers.call(nina, 'bash', { command: 'echo oi' }, ctx)
    const text = out.result.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    expect(out.result.isError).toBe(true)
    expect(text).toContain('A preparação do computador falhou')
    expect(text).toContain('baixando ferramenta')
    await computers.erase(nina.id)
  }, 300_000)
})
