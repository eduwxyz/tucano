// The new-version note on screen: the Tuca says it in a bubble under his row, typing it out, and his row
// calls for attention while the version waits. The app's updater is a stand-in: the test hands the
// window the state it would send.
import { parseHTML } from 'linkedom'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { UpdateState } from '../src/shared/types'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
let still = false
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(window, { matchMedia: () => ({ matches: still }) })
let send: (s: UpdateState) => void = () => {}
const installUpdate = vi.fn()
Object.assign(window, { tucano: { updateState: async () => ({ version: '0.2.45', status: 'latest' }), onUpdate: (cb: (s: UpdateState) => void) => (send = cb), installUpdate } })

let working = new Set<string>()
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: never) => T): T => select({} as never), workingAgents: () => working }
})
const { createRoot } = await import('react-dom/client')
const { UpdateNote, useTucaCall } = await import('../src/renderer/src/components/Update')

// What the Tuca's row in the sidebar reads (Sidebar.tsx).
function Row(): ReactNode {
  const { calling, talking } = useTucaCall()
  return <span className={`row ${calling ? 'is-calling' : ''} ${talking ? 'is-talking' : ''}`} />
}

const ready: UpdateState = { version: '0.2.45', status: 'ready', next: '0.2.46' }
const SAID = 'Chegou o Tucano 0.2.46! Quer reiniciar pra usar?'
let root: Root
const host = (): Element => document.getElementById('root')!
const q = (sel: string): Element | null => host().querySelector(sel)
const typed = (): string => q('.update-note__said > span:last-child')?.textContent ?? ''

async function show(ui: ReactNode): Promise<void> {
  root = createRoot(host())
  await act(async () => root.render(ui))
}

beforeEach(() => {
  setLang('pt')
  still = false
  working = new Set()
  installUpdate.mockClear()
  vi.useFakeTimers()
})
afterEach(async () => {
  await act(async () => root.unmount())
  await act(async () => send({ version: '0.2.45', status: 'latest' }))
  vi.useRealTimers()
})

describe('the new-version note', () => {
  it('says nothing, and the Tuca stays quiet, until a version is ready', async () => {
    await show(
      <>
        <Row />
        <UpdateNote />
      </>
    )
    expect(q('.update-note')).toBeNull()
    expect(q('.row.is-calling')).toBeNull()
  })

  it('has the Tuca type it out under his row, his beak going, and then the button', async () => {
    await show(
      <>
        <Row />
        <UpdateNote />
      </>
    )
    await act(async () => send(ready))
    expect(typed()).toBe('')
    expect(q('.sr-only')?.textContent).toBe(SAID) // read whole, at once
    expect(q('.update-note__ghost')?.textContent).toBe(SAID) // the bubble's size from the start
    expect(q('.update-note__after.is-waiting')).not.toBeNull()
    expect(q('.row.is-calling.is-talking')).not.toBeNull()
    expect(q('.update-note .avatar')).toBeNull() // one Tuca: his row's

    await act(async () => vi.advanceTimersByTime(300))
    expect(typed().length).toBeGreaterThan(0)
    expect(SAID.startsWith(typed())).toBe(true)

    await act(async () => vi.advanceTimersByTime(SAID.length * 30 + 100))
    expect(typed()).toBe(SAID)
    expect(q('.update-note__caret')).toBeNull()
    expect(q('.update-note__after.is-waiting')).toBeNull()
    expect(q('.row.is-calling')).not.toBeNull()
    expect(q('.row.is-talking')).toBeNull() // done talking, still calling
    expect(q('.update-note a')?.getAttribute('href')).toBe('https://github.com/eduwxyz/tucano/releases/tag/v0.2.46')
    ;(q('.update-note button') as HTMLButtonElement).click()
    expect(installUpdate).toHaveBeenCalledOnce()
  })

  it('says it all at once with reduced motion', async () => {
    still = true
    await show(<UpdateNote />)
    await act(async () => send(ready))
    expect(typed()).toBe(SAID)
    expect(q('.update-note__after.is-waiting')).toBeNull()
  })

  it('brings the Tuca along when his row is out of the sidebar', async () => {
    still = true
    await show(<UpdateNote alone />)
    await act(async () => send(ready))
    expect(q('.update-note--alone .avatar--tuca')).not.toBeNull()
  })

  it('warns that restarting cuts an agent off, and drops the link meanwhile', async () => {
    still = true
    working = new Set(['lia'])
    await show(<UpdateNote />)
    await act(async () => send(ready))
    expect(host().textContent).toContain('1 agente trabalhando')
    expect(q('.update-note button')?.textContent).toBe('Reiniciar mesmo assim')
    expect(q('.update-note a')).toBeNull()
  })
})
