import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import type { SettingsSection } from '../settings-structure'

export const SETTINGS_SCROLL_MS = 280
export const settingsEase = (t: number): number => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

// The strip under a page's own tabs: the sections of the open tab, in the order their cards read,
// sticking under the tabs while the page scrolls, and taking the pane to a section. It is a second
// row of links and not another tab list — the sections stay visible together and are all part of one
// scrolling document, so the links carry `aria-current="location"` instead of a selected tab. The
// strip is its own container: a wrapper around it would end at its own edge, and a sticky row cannot
// leave the block it is in, so it would scroll away with the page.
export function SettingsLayout({ sections }: { sections: readonly SettingsSection[] }): ReactNode {
  // The cards belong to the page, so the strip lists the sections that were really rendered, in the
  // order they read: a section whose card is missing, or one this person's role leaves out, gets no
  // link and no dead anchor.
  const [present, setPresent] = useState<readonly string[] | null>(null)
  const listed = sections.filter(section => section.visible)
  const available = present
    ? present.map(id => listed.find(section => section.id === id)).filter((section): section is SettingsSection => section !== undefined)
    : listed
  const [current, setCurrent] = useState<string>(listed[0]?.id ?? '')
  const currentId = available.some(section => section.id === current) ? current : available[0]?.id ?? ''
  const root = useRef<HTMLElement>(null)
  const frame = useRef<number | null>(null)
  const movingTo = useRef<string | null>(null)
  // The reading-position check, so a move that ends can name what it really landed on.
  const track = useRef<() => void>(() => {})
  // A tab opens at its first section, whatever scroll position the page was left at.
  const opened = useRef(false)
  // How far the page's own tab bar reaches down: the strip parks under it instead of over it.
  const above = useRef(0)
  const ids = listed.map(section => section.id).join('|')

  const cancel = (): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    movingTo.current = null
    root.current?.removeAttribute('data-settings-scrolling')
  }

  const showSection = (id: string, animated: boolean, focus: boolean): void => {
    cancel()
    const scroller = root.current?.closest<HTMLElement>('.page__scroll')
    const target = scroller?.querySelector<HTMLElement>(`[data-settings-section="${id}"]`)
    if (!scroller || !target) return
    setCurrent(id)
    const inset = (root.current?.getBoundingClientRect().height ?? 0) + above.current + 16
    const destinationTop = (): number => Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight,
      scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - inset))
    const top = destinationTop()
    if (focus) target.focus({ preventScroll: true })
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const start = scroller.scrollTop
    if (!animated || reduced || Math.abs(top - start) < 1) {
      scroller.scrollTop = top
      track.current()
      return
    }
    movingTo.current = id
    root.current?.setAttribute('data-settings-scrolling', id)
    let began: number | null = null
    const step = (at: number): void => {
      began ??= at
      const progress = Math.min(1, (at - began) / SETTINGS_SCROLL_MS)
      scroller.scrollTop = start + (destinationTop() - start) * settingsEase(progress)
      if (progress < 1) frame.current = requestAnimationFrame(step)
      else {
        frame.current = null
        movingTo.current = null
        root.current?.removeAttribute('data-settings-scrolling')
        track.current()
      }
    }
    frame.current = requestAnimationFrame(step)
  }

  useLayoutEffect(() => {
    const element = root.current
    const scroller = element?.closest<HTMLElement>('.page__scroll')
    if (!element || !scroller) return
    // The strip sticks right below the page's own tabs, whose height changes with the window, and
    // the page keeps room under its last card so that card can reach the line like every other one.
    const size = (): void => {
      above.current = scroller.querySelector<HTMLElement>('.tabs:not(.tabs--sections)')?.getBoundingClientRect().height ?? 0
      element.style.setProperty('--settings-nav-top', `${above.current}px`)
      const tail = Math.max(0, scroller.clientHeight - above.current - element.getBoundingClientRect().height - 32)
      scroller.style.setProperty('--settings-tail', `${tail}px`)
    }
    size()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(size)
    observer?.observe(scroller)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [ids])

  useLayoutEffect(() => {
    const scroller = root.current?.closest<HTMLElement>('.page__scroll')
    if (!scroller) return
    const wanted = new Set<string>(listed.map(section => section.id))
    const seen: string[] = []
    for (const element of Array.from(scroller.querySelectorAll<HTMLElement>('[data-settings-section]'))) {
      const id = element.dataset.settingsSection
      if (id && wanted.has(id) && !seen.includes(id)) seen.push(id)
    }
    setPresent(previous => previous && previous.join('|') === seen.join('|') ? previous : seen)
    if (!opened.current) {
      opened.current = true
      // The strip mounts with its tab: the page above it may still be scrolled where the previous
      // tab left it, and a section nobody asked for would be named there.
      scroller.scrollTop = 0
      setCurrent(seen[0] ?? listed[0]?.id ?? '')
      return
    }
    if (seen.length > 0) setCurrent(current => seen.includes(current) ? current : seen[0]!)
  }, [ids])

  useEffect(() => {
    const scroller = root.current?.closest<HTMLElement>('.page__scroll')
    if (!scroller) return
    let tracking: number | null = null
    // The reading position: the last section whose card has reached the line under the strip, or the
    // last one of all once the pane is at its end.
    const read = (): void => {
      if (tracking !== null) return
      tracking = requestAnimationFrame(() => {
        tracking = null
        if (movingTo.current) return
        const targets = [...scroller.querySelectorAll<HTMLElement>('[data-settings-section]')]
        const line = scroller.getBoundingClientRect().top + (root.current?.getBoundingClientRect().height ?? 0) + above.current + 24
        const selected = targets.filter(element => element.getBoundingClientRect().top <= line).at(-1) ?? targets[0]
        if (selected?.dataset.settingsSection) setCurrent(selected.dataset.settingsSection)
      })
    }
    track.current = read
    const interrupt = (): void => { cancel(); read() }
    const interruptKey = (event: KeyboardEvent): void => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ', 'Escape'].includes(event.key)) interrupt()
    }
    read()
    scroller.addEventListener('scroll', read, { passive: true })
    scroller.addEventListener('wheel', interrupt, { passive: true })
    scroller.addEventListener('touchstart', interrupt, { passive: true })
    scroller.addEventListener('pointerdown', interrupt, { passive: true })
    scroller.addEventListener('keydown', interruptKey)
    window.addEventListener('resize', interrupt)
    return () => {
      cancel()
      if (tracking !== null) cancelAnimationFrame(tracking)
      track.current = () => {}
      scroller.removeEventListener('scroll', read)
      scroller.removeEventListener('wheel', interrupt)
      scroller.removeEventListener('touchstart', interrupt)
      scroller.removeEventListener('pointerdown', interrupt)
      scroller.removeEventListener('keydown', interruptKey)
      window.removeEventListener('resize', interrupt)
    }
  }, [ids])

  // The active link follows the selection sideways, without scrolling the page itself.
  useEffect(() => {
    const link = root.current?.querySelector<HTMLElement>('[aria-current="location"]')
    const strip = link?.parentElement
    if (!link || !strip) return
    if (link.offsetLeft < strip.scrollLeft) strip.scrollLeft = link.offsetLeft
    else if (link.offsetLeft + link.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = link.offsetLeft + link.offsetWidth - strip.clientWidth
  }, [currentId])

  const chooseSection = (event: MouseEvent<HTMLAnchorElement>, id: string): void => {
    // A modified click belongs to the person's browser, not to this strip.
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    event.preventDefault()
    // A keyboard activation arrives with no click count, and it moves at once.
    showSection(id, event.detail > 0, true)
  }

  return (
    <nav className="settings-layout tabs tabs--sections settings-sections" aria-label={L('Seções de configurações', 'Settings sections')} ref={root}>
      {available.map(section => (
        <a key={section.id} href={`#settings-${section.id}`} aria-current={currentId === section.id ? 'location' : undefined}
          onClick={event => chooseSection(event, section.id)}>{section.label}</a>
      ))}
    </nav>
  )
}
