import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ api: null as any, listeners: new Map<string, Function>(), windowEvents: new Map<string, Function>(),
  saveResult: 'saved', send: vi.fn(), sync: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { h.api = api } },
  ipcRenderer: {
    on: (channel: string, listener: Function) => h.listeners.set(channel, listener), removeListener: vi.fn(),
    send: h.send, invoke: vi.fn(), sendSync: h.sync
  }
}))
const initial = [['conversation', { text: 'Saved for this environment', images: [] }]]
afterEach(() => vi.unstubAllGlobals())
beforeEach(async () => {
  vi.resetModules(); h.listeners.clear(); h.windowEvents.clear(); h.send.mockClear(); h.sync.mockReset(); h.saveResult = 'saved'
  h.sync.mockImplementation((channel: string) => channel === 'drafts:open' ? { session: 'private-page-session', entries: initial } : channel === 'drafts:save' ? h.saveResult : false)
  vi.stubGlobal('window', { postMessage: vi.fn(), addEventListener: (name: string, listener: Function) => h.windowEvents.set(name, listener) })
  await import('../src/preload/index')
})

describe('private preload draft scope', () => {
  it('exposes draft content but never the scope/session selector to the renderer', () => {
    expect(h.api.drafts.read()).toEqual(initial)
    expect(Object.keys(h.api.drafts)).toEqual(['read', 'onCheckpoint'])
    expect(JSON.stringify(h.api)).not.toContain('private-page-session')
    const updated = [['conversation', { text: 'Unsent text', images: [] }]]
    h.api.drafts.onCheckpoint(() => updated)
    h.listeners.get('drafts:checkpoint')!({}, 7)
    expect(h.send).toHaveBeenCalledWith('drafts:checkpoint', 7, 'private-page-session', updated)
    const event = { preventDefault: vi.fn(), returnValue: undefined }
    h.windowEvents.get('beforeunload')!(event)
    expect(h.sync).toHaveBeenCalledWith('drafts:save', 'private-page-session', updated)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
  it('blocks an ordinary reload on failed checkpoint but permits an explicitly forgotten page to unload', () => {
    h.saveResult = 'invalid'
    const event = { preventDefault: vi.fn(), returnValue: undefined }
    h.windowEvents.get('beforeunload')!(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    h.saveResult = 'forgotten'; event.preventDefault.mockClear()
    h.windowEvents.get('beforeunload')!(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
  it('reports failed draft preparation without leaking the exception or switching scope', () => {
    h.api.drafts.onCheckpoint(() => { throw new Error('Private text') })
    h.listeners.get('drafts:checkpoint')!({}, 8)
    expect(h.send).toHaveBeenCalledWith('drafts:checkpoint', 8, 'private-page-session', undefined)
    expect(JSON.stringify(h.send.mock.calls)).not.toContain('Private text')
  })
})
