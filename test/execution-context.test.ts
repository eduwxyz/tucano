import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLang } from '../src/shared/lang'
import { hostAccessWarning, hostComputerLabel, serverExecution } from '../src/renderer/src/execution-context'
import { AgentPage, ConnectorsPage } from '../src/renderer/src/components/Pages'
import { Onboarding } from '../src/renderer/src/components/Onboarding'
import { getState, newAgentDraft, type State } from '../src/renderer/src/store'

const splash = vi.hoisted(() => {
  vi.stubGlobal('window', { tucano: {} })
  return { finish: undefined as (() => void) | undefined }
})
vi.mock('../src/renderer/src/components/Splash', () => ({
  Splash: ({ onDone }: { onDone: () => void }) => { splash.finish = onDone; return null }
}))
// Server rendering checks real component copy without connecting to a core, making
// OS calls or enabling any agent capabilities. Effects and RPCs never run here.
vi.mock('../src/renderer/src/store', async (importOriginal) => {
  const store = await importOriginal<typeof import('../src/renderer/src/store')>()
  return { ...store, useStore: <T>(select: (state: State) => T): T => select(store.getState()) }
})

function client(mode: 'local' | 'native' | 'web'): void {
  vi.stubGlobal('window', {
    tucano: { remoteMode: mode === 'native', clientPlatform: 'windows' },
    __TUCANO_WEB__: mode === 'web',
    location: { hostname: 'localhost' }
  })
}

beforeEach(() => {
  client('local')
  setLang('en')
  const state = getState()
  state.agents = [{ ...newAgentDraft(), id: 'fixture', name: 'Lia', handle: 'lia', browser: true, computer: true, computerKind: 'mac' }]
  state.computers = []
  state.connectors = []
  state.tabs = { agent: 'ferramentas' }
  // The execution platform is Linux even when the renderer is a Windows client.
  state.platform = 'linux'
})

afterEach(() => { vi.unstubAllGlobals(); setLang('pt') })

function welcome(): string {
  const markup = renderToStaticMarkup(createElement(Onboarding))
  if (markup) return markup
  splash.finish?.()
  return renderToStaticMarkup(createElement(Onboarding))
}

describe('execution target wording', () => {
  it('preserves local computer labels and account warnings', () => {
    expect(serverExecution()).toBe(false)
    expect(hostComputerLabel()).toBe('This computer')
    expect(hostAccessWarning().title).toBe('Its commands will run right on your computer, as you.')
    expect(hostAccessWarning().detail).toContain('your files, your other projects')
    const page = renderToStaticMarkup(createElement(AgentPage, { id: 'fixture' }))
    expect(page).toContain('role="radio" aria-checked="true" class="is-active">This computer')
    expect(page).toContain('on your computer')
    expect(page).toContain('Opens its browser window so you can sign in to accounts')
    expect(page).toContain('<button class="btn btn--sm btn--ghost">Open its folder</button>')
    expect(page).not.toContain('Connected server')
    expect(welcome()).toContain('Conversations, memory and logins stay on your computer.')
  })

  for (const mode of ['native', 'web'] as const) {
    it(`names the server account in ${mode} mode, including a localhost web URL`, () => {
      client(mode)
      expect(serverExecution()).toBe(true)
      expect(hostComputerLabel()).toBe('Connected server')
      expect(hostAccessWarning().title).toContain('as the account running Tucano')
      expect(hostAccessWarning().detail).toContain('credentials on disk (tokens, ~/.ssh)')
      expect(hostAccessWarning().detail).toContain('accessible to that server account')
      expect(hostAccessWarning().title).not.toContain('your computer')
      const page = renderToStaticMarkup(createElement(AgentPage, { id: 'fixture' }))
      expect(page).toContain('role="radio" aria-checked="true" class="is-active">Connected server')
      expect(page).toContain('on the connected server')
      expect(page).toContain('Take over server browser')
      expect(page).toContain('server’s desktop session')
      expect(page).not.toContain('This computer')
      expect(page).not.toContain('your Mac')
      expect(page).not.toContain('on your computer')
      expect(page).toContain('disabled="" aria-describedby="computer-folder-fixture">Open its folder')
      expect(page).toContain('id="computer-folder-fixture"')
      expect(page).toContain('This interface cannot open server folders')
      expect(page).not.toContain('Server path:')
      const intro = welcome()
      expect(intro).toContain('working on the connected server.')
      expect(intro).toContain('Conversations, memory and logins stay on the connected server.')
      expect(intro).not.toContain('Everything stays here')
      expect(intro).not.toContain('stay on your computer')
    })

    it(`locates Docker, lent files and local connectors on the server in ${mode} mode`, () => {
      client(mode)
      getState().agents[0]!.computerKind = 'linux'
      getState().computers = [{ agentId: 'fixture', state: 'running', folder: '/srv/tucano/agents/fixture', services: [] }]
      const page = renderToStaticMarkup(createElement(AgentPage, { id: 'fixture' }))
      expect(page).toContain('Isolated Linux uses the server’s Docker')
      expect(page).toContain('Docker and the /work folder are on the connected server')
      expect(page).toContain('Folders from the connected server')
      expect(page).toContain('The path must exist there')
      expect(page).toContain('disabled="" aria-describedby="computer-folder-fixture">Open folder')
      expect(page).toContain('Server path:')
      expect(page).toContain('<code>/srv/tucano/agents/fixture</code>')
      expect(page).not.toContain('Folders from your computer')
      expect(renderToStaticMarkup(createElement(ConnectorsPage))).toContain('runs as a process on the connected server')
    })
  }

  it('recognizes the web execution host without a native preload', () => {
    vi.stubGlobal('window', { __TUCANO_WEB__: true })
    expect(serverExecution()).toBe(true)
    expect(hostComputerLabel()).toBe('Connected server')
  })

  it('resolves both languages at render time and returns to local copy', () => {
    client('native')
    setLang('pt')
    expect(hostComputerLabel()).toBe('Servidor conectado')
    expect(hostAccessWarning().title).toContain('conta que executa o Tucano')
    expect(welcome()).toContain('Conversas, memória e logins ficam no servidor conectado.')
    setLang('en')
    expect(hostComputerLabel()).toBe('Connected server')
    expect(hostAccessWarning().title).toContain('account running Tucano')
    client('local')
    setLang('pt')
    expect(hostComputerLabel()).toBe('Este computador')
    expect(hostAccessWarning().title).toBe('Os comandos dele vão rodar direto no seu computador, como você.')
  })
})
