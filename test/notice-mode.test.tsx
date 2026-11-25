// Settings › General › Notifications has one choice of two: Native leaves 0.2.37's own system
// notifications exactly as they were and shows none of the cards' settings, and Enhanced shows
// them and draws the cards over every window. A notification already on stays on, as Enhanced.
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import { noticeModeOf, noticeOf } from '../src/shared/notice'
import { PERSONAL_SETTINGS } from '../src/core/policy-people'
import { settingsPatchError } from '../src/core/settings-patch'
import { NotificationCard } from '../src/renderer/src/components/Pages'
import type { Settings } from '../src/shared/types'

const settings = (notice: Settings['notice']): Settings => ({ workspaceName: 'Casa', context: '', notice }) as Settings
const drawn = (notice: Settings['notice']): string => renderToStaticMarkup(<NotificationCard settings={settings(notice)} update={() => {}} />)

// The words of the rows that only the cards have, in the language the page is in.
const CARDS_ONLY = ['Where they appear', 'Decide from the notification', 'Skin', 'Time on screen', 'Stack mode', 'Stays under the pointer']

beforeEach(() => {
  setLang('en')
  // The page talks to the app through window.tucano: the system's test in Native, the cards in Enhanced.
  ;(globalThis as { window?: unknown }).window = { tucano: { testNotify: () => Promise.resolve('shown'), notifyState: () => 'on', notice: { demo: () => {}, pick: () => {} } } }
})
afterEach(() => {
  delete (globalThis as { window?: unknown }).window
  setLang('pt')
})

describe('Settings › Notifications: Native or Enhanced', () => {
  it('is Enhanced by default, so a notification already on keeps coming', () => {
    expect(noticeModeOf(undefined)).toBe('enhanced')
    expect(noticeOf({}).mode).toBe('enhanced')
    expect(noticeOf({}).on).toBe(true)
    // The old on/off still reads: off meant the system's own, and that is Native now.
    expect(noticeModeOf({ on: false })).toBe('native')
    // A mode chosen since wins over that switch.
    expect(noticeModeOf({ mode: 'enhanced', on: false })).toBe('enhanced')
    expect(noticeModeOf({ mode: 'native', on: true })).toBe('native')
  })

  it('offers both modes beside the notifications card, in the settings’ own segmented row', () => {
    const html = drawn({ mode: 'native' })
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('How notifications arrive')
    expect(html).toContain('Native')
    expect(html).toContain('Enhanced')
    expect(html).toMatch(/aria-checked="true"[^>]*>Native/)
    expect(html).toMatch(/aria-checked="false"[^>]*>Enhanced/)
  })

  it('Native hides every enhanced setting and leaves the system’s own notification in place', () => {
    const html = drawn({ mode: 'native' })
    for (const row of CARDS_ONLY) expect(html).not.toContain(row)
    // No way to place, time, skin or stack a card that isn't drawn, and no card demo.
    expect(html).not.toContain('Choose the area')
    expect(html).not.toContain('Test notifications')
    expect(html).toContain('The system’s own notifications, as they always were.')
    // What is left is 0.2.37's own: one from the system now.
    expect(html).toContain('Send one')
    // And the main process keeps the system's route: the cards' window stays off.
    expect(noticeOf({ notice: { mode: 'native' } }).on).toBe(false)
  })

  it('Enhanced shows the enhanced settings and tests the cards', () => {
    const html = drawn({ mode: 'enhanced' })
    for (const row of CARDS_ONLY) expect(html).toContain(row)
    expect(html).toContain('Choose the area')
    expect(html).toContain('Test notifications')
    expect(html).not.toContain('Send one')
    expect(noticeOf({ notice: { mode: 'enhanced' } }).on).toBe(true)
  })

  it('keeps a setting made in Enhanced when the mode is written, and takes the mode in a patch as anyone’s own', () => {
    expect(settingsPatchError({ notice: { mode: 'native' } })).toBeUndefined()
    expect(settingsPatchError({ notice: { mode: 'enhanced', act: false, seconds: 9 } })).toBeUndefined()
    expect(settingsPatchError({ notice: 'native' })).toBeDefined()
    expect(PERSONAL_SETTINGS).toContain('notice')
    // The settings the other mode reads are kept, not dropped: coming back finds them as they were.
    const kept = noticeOf({ notice: { mode: 'native', skin: 'dark', seconds: 20, stack: true } })
    expect(kept).toMatchObject({ mode: 'native', skin: 'dark', seconds: 20, stack: true })
  })

  it('draws a successful notice’s time bar in the signature orange, never the success green', () => {
    const css = readFileSync('src/renderer/src/notice/notice.css', 'utf8')
    const done = /\.nc--done \{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(done).toContain('--kind: var(--toast-ink)')
    expect(done).not.toContain('var(--ok)')
    // The bar along the bottom edge is what reads it.
    const ring = /\.nc__ring \{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(ring).toContain('background: var(--kind)')
  })
})
