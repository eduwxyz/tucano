// The clock the app reads (#393): 24 hours, or 12 with am/pm, chosen in Settings › Yours. One helper
// decides the shape, so a time in the transcript, a routine's schedule and the context an agent is
// handed all agree, and the language only picks the locale.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clock, hour12, hourStyle, setClock, timeOpts } from '../src/shared/clock'
import { setLang } from '../src/shared/lang'
import { settingsPatchError } from '../src/core/settings-patch'

const at = (h: number, m: number): Date => new Date(2026, 10, 12, h, m)
const read = (d: Date): string => d.toLocaleTimeString('en-US', timeOpts({ hour: hourStyle(), minute: '2-digit' }))

describe('the clock the app reads by', () => {
  it('is 24 hours untouched, and 12 only when it was chosen', () => {
    setLang('pt')
    setClock(undefined)
    expect(clock()).toBe('24')
    setClock('12')
    expect(clock()).toBe('12')
    expect(hour12()).toBe(true)
    setClock('24')
    expect(hour12()).toBe(false)
    // Unset follows the language exactly as the app read before there was a setting.
    setLang('en')
    setClock(undefined)
    expect(clock()).toBe('12')
  })

  it('reads 15:05 on 24, 3:05 PM on 12, and midnight as 12:00 AM', () => {
    setClock('24')
    expect(read(at(15, 5))).toBe('15:05')
    expect(read(at(0, 0))).toBe('00:00')
    setClock('12')
    expect(read(at(15, 5))).toBe('3:05 PM')
    expect(read(at(0, 0))).toBe('12:00 AM')
    expect(read(at(12, 0))).toBe('12:00 PM')
  })

  it('takes the two clocks and nothing else', () => {
    expect(settingsPatchError({ clock: '24' })).toBeUndefined()
    expect(settingsPatchError({ clock: '12' })).toBeUndefined()
    expect(settingsPatchError({ clock: '13' })).toBeTruthy()
    expect(settingsPatchError({ clock: 24 })).toBeTruthy()
  })

  it('is the one helper every time in the app goes through', () => {
    const root = join(import.meta.dirname, '..', 'src')
    for (const f of ['core/context.ts', 'core/routines.ts', 'core/runs.ts', 'core/wiki-curator.ts',
      'renderer/src/components/Panel.tsx', 'renderer/src/components/Routines.tsx', 'renderer/src/components/ui.tsx',
      'renderer/src/components/Usage.tsx', 'renderer/src/components/Conversation.tsx']) {
      const text = readFileSync(join(root, f), 'utf8')
      expect(text, `${f} formats a time without the clock's options`).toContain('timeOpts(')
    }
  })
})
