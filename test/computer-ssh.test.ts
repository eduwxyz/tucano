import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Agent, Settings } from '../src/shared/types'
import { Computers, SSH_FILES, SSH_SOCK, sshForward } from '../src/core/computer'
import { systemPrompt } from '../src/core/context'
import { Db } from '../src/core/db'

const ready = { installed: true, loggedIn: true }
const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, gemini: ready, cursor: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
// Ids that start apart: a computer's name is the first 8 characters of its agent's id.
const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: 'lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: true, archived: false, ...extra })

describe('sharing the person’s SSH with an agent’s computer', () => {
  it('hands in the session’s agent socket on Linux, Docker Desktop’s own on a Mac, and says why not on Windows', () => {
    const yes = (): boolean => true
    expect(sshForward({ platform: 'linux', desktop: false, sock: '/run/user/1000/keyring/ssh', exists: yes })).toEqual({ args: ['-v', `/run/user/1000/keyring/ssh:${SSH_SOCK}`, '-e', `SSH_AUTH_SOCK=${SSH_SOCK}`] })
    expect(sshForward({ platform: 'darwin', desktop: true, exists: yes })).toEqual({ args: ['-v', '/run/host-services/ssh-auth.sock:/run/host-services/ssh-auth.sock', '-e', 'SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock'] })
    expect(sshForward({ platform: 'linux', desktop: true, exists: yes })).toMatchObject({ args: expect.arrayContaining(['SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock']) })
    expect(sshForward({ platform: 'linux', desktop: false, exists: yes })).toMatchObject({ why: expect.stringContaining('SSH_AUTH_SOCK') })
    expect(sshForward({ platform: 'linux', desktop: false, sock: '/tmp/gone', exists: () => false })).toMatchObject({ why: expect.stringContaining('ssh-add') })
    expect(sshForward({ platform: 'win32', desktop: true, exists: yes })).toMatchObject({ why: expect.stringContaining('No Windows') })
  })

  it('copies config, known_hosts and public keys, never a private key', () => {
    expect(SSH_FILES(['config', 'known_hosts', 'id_ed25519', 'id_ed25519.pub', 'id_rsa', 'work.pub', 'authorized_keys', 'agent.sock'])).toEqual(['config', 'known_hosts', 'id_ed25519.pub', 'work.pub'])
  })

  it('is kept with the agent, off unless turned on', () => {
    const db = new Db(join(mkdtempSync(join(tmpdir(), 'tucano-ssh-db-')), 'test.db'))
    db.saveAgent(agent('a1'))
    expect(db.agent('a1')!.ssh).toBeUndefined()
    db.saveAgent({ ...db.agent('a1')!, ssh: true })
    expect(db.agent('a1')!.ssh).toBe(true)
    db.close()
  })

  it('tells the agent it signs as the person, only when it’s on', () => {
    const conv = { id: 'd', kind: 'dm' as const, name: 'a1', members: ['a1'] }
    expect(systemPrompt({ agent: agent('a1', { ssh: true }), settings, conversation: conv, peers: [], hasComputer: true })).toContain('Você usa o SSH de Edu')
    expect(systemPrompt({ agent: agent('a1'), settings, conversation: conv, peers: [], hasComputer: true })).not.toContain('SSH de Edu')
  })
})

const hasDocker = ((): boolean => {
  try {
    execFileSync('docker', ['image', 'inspect', 'node:22-bookworm'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!hasDocker)('sharing the person’s SSH (Docker)', () => {
  // A ~/.ssh of the person's own, in a home of the test's.
  const home = mkdtempSync(join(tmpdir(), 'tucano-ssh-home-'))
  mkdirSync(join(home, '.ssh'))
  writeFileSync(join(home, '.ssh', 'config'), 'Host gitlab-work\n  HostName gitlab.com\n  IdentityFile ~/.ssh/work\n')
  writeFileSync(join(home, '.ssh', 'known_hosts'), 'gitlab.com ssh-ed25519 AAAAC3Nza\n')
  writeFileSync(join(home, '.ssh', 'work'), '-----BEGIN OPENSSH PRIVATE KEY-----\nsegredo\n')
  writeFileSync(join(home, '.ssh', 'work.pub'), 'ssh-ed25519 AAAAC3Nza edu@maquina\n')
  const before = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] }
  process.env['HOME'] = home
  process.env['USERPROFILE'] = home

  const dataDir = mkdtempSync(join(tmpdir(), 'tucano-ssh-'))
  const db = new Db(join(dataDir, 'test.db'))
  const lia = agent('55a00001-0000-4000-8000-000000000001', { ssh: true })
  db.saveAgent(lia)
  const computers = new Computers({ db, dataDir, emit: () => {} })
  const sh = async (command: string): Promise<string> => {
    const out = await computers.call(lia, 'bash', { command }, { conversationId: 'd', messageId: 'm' })
    return out.result.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
  }
  const copy = (on: boolean): Promise<void> => (computers as unknown as { copySsh: (id: string, on: boolean) => Promise<void> }).copySsh(lia.id, on)

  afterAll(async () => {
    await computers.erase(lia.id)
    process.env['HOME'] = before.HOME
    process.env['USERPROFILE'] = before.USERPROFILE
  }, 120_000)

  it('puts the config, known_hosts and the public key in, never the private one; off takes them out', async () => {
    await computers.ensure(lia.id)
    if (process.platform === 'win32') expect(computers.info(lia).ssh).toContain('No Windows') // the socket can't go in here
    await copy(true) // what a Linux or Mac host does once the socket is in
    const listed = await sh('ls -la /root/.ssh && cat /root/.ssh/config')
    expect(listed).toContain('config')
    expect(listed).toContain('known_hosts')
    expect(listed).toContain('work.pub')
    expect(listed).not.toMatch(/\swork\n/) // the private key stayed home
    expect(listed).toContain('Host gitlab-work')
    expect(await sh('stat -c %a /root/.ssh/config')).toContain('600')

    await copy(false)
    const after = await sh('ls -a /root/.ssh')
    expect(after).not.toContain('config')
    expect(after).not.toContain('work.pub')
  }, 300_000)
})
