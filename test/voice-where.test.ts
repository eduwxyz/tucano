// Renata (Tucano Pro, 19/11) waited for her dictation and gave up: the screen said the audio became text "on
// this computer, offline", but on a server it's the server's few shared processors, where the Recommended model
// took 47 s for 8 s of speech and the Light one 9 s. On a server the screen says where it runs, and which is faster.
import { parseHTML } from 'linkedom'
import { afterEach, describe, expect, it } from 'vitest'

const { window } = parseHTML('<!doctype html><html><body></body></html>')
Object.assign(globalThis, { window })
const { VOICE_CHOICES, VOICE_WHERE } = await import('../src/renderer/src/components/VoiceSetup')

describe('where dictation says the audio becomes text', () => {
  afterEach(() => void Object.assign(window, { __TUCANO_WEB__: undefined }))

  it('on a computer: here, offline', () => {
    expect(VOICE_WHERE()).toBe('O áudio vira texto neste computador, sem internet.')
  })

  it('on a server: the server, and the Light model is the faster one there', () => {
    Object.assign(window, { __TUCANO_WEB__: true })
    expect(VOICE_WHERE()).toContain('no servidor deste Tucano')
    expect(VOICE_WHERE()).not.toContain('neste computador')
    expect(VOICE_CHOICES().find((c) => c.id === 'light')?.about).toContain('Num servidor, transcreve umas 5 vezes mais rápido')
  })
})
