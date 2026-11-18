import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { settingsDestination, type SettingsPageId, type SettingsSection, type SettingsSectionId } from '../settings-structure'

export const SETTINGS_SCROLL_MS = 280
export const settingsEase = (t: number): number => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

// One settings pane's sections: the rail names them, stays while the pane scrolls, and moves the
// pane to a section. The page's own tabs decide which pane is showing.
export function SettingsLayout({ page, requested, sections, content, onNavigate }: {
  page: SettingsPageId
  requested?: string
  sections: readonly SettingsSection[]
  content: Record<SettingsSectionId, ReactNode>
  onNavigate: (section: string) => void
}): ReactNode {
  const available = sections.filter(s => s.visible && s.page === page)
  const wanted = settingsDestination(requested, sections).section
  const destination = available.some(s => s.id === wanted) ? wanted : available[0]?.id ?? ''
  const root = useRef<HTMLDivElement>(null)
  const navigation = useRef<HTMLDivElement>(null)
  const frame = useRef<number | null>(null)
  const movingTo = useRef<string | null>(null)
  const handled = useRef<string | undefined>(undefined)
  const previousPage = useRef<string | null>(null)
  const [current, setCurrent] = useState<string>(destination)
  const currentId = available.some(s => s.id === current) ? current : destination
  const ids = available.map(s => s.id).join('|')

  const cancel = (): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    movingTo.current = null
    root.current?.removeAttribute('data-settings-scrolling')
  }

  const showSection = (id: string, animated: boolean, focus: boolean): void => {
    cancel()
    const scroller = root.current?.closest<HTMLElement>('.page__scroll')
    const target = root.current?.querySelector<HTMLElement>(`[data-settings-section="${id}"]`)
    if (!scroller || !target) return
    setCurrent(id)
    const inset = (navigation.current?.getBoundingClientRect().height ?? 0) + 16
    const destinationTop = (): number => Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight,
      scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - inset))
    const top = destinationTop()
    if (focus) target.focus({ preventScroll: true })
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const start = scroller.scrollTop
    if (!animated || reduced || Math.abs(top - start) < 1) {
      scroller.scrollTop = top
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
      else { frame.current = null; movingTo.current = null; root.current?.removeAttribute('data-settings-scrolling') }
    }
    frame.current = requestAnimationFrame(step)
  }

  useLayoutEffect(() => {
    const element = root.current
    const scroller = element?.closest<HTMLElement>('.page__scroll')
    if (!element || !scroller) return
    // Enough trailing room lets the final section reach the same top edge as every other one.
    const size = (): void => element.style.setProperty('--settings-last-height', `${Math.max(0, scroller.clientHeight - (navigation.current?.getBoundingClientRect().height ?? 0) - 16)}px`)
    size()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(size)
    observer?.observe(scroller)
    if (navigation.current) observer?.observe(navigation.current)
    return () => observer?.disconnect()
  }, [page, ids])

  useLayoutEffect(() => {
    // A destination or a tab change sets the section once; scrolling afterwards only marks it.
    const landing = `${page}:${requested ?? ''}`
    if (handled.current === landing && previousPage.current === page) return
    const changed = previousPage.current !== page
    handled.current = landing
    previousPage.current = page
    cancel()
    const asked = requested !== undefined && available.some(s => s.id === wanted)
    const target = asked ? wanted : destination
    if (asked) showSection(target, false, true)
    else if (changed) {
      const scroller = root.current?.closest<HTMLElement>('.page__scroll')
      if (scroller) scroller.scrollTop = 0
      setCurrent(target)
    }
  }, [page, requested, destination, ids])

  useEffect(() => {
    const scroller = root.current?.closest<HTMLElement>('.page__scroll')
    if (!scroller) return
    let tracking: number | null = null
    const track = (): void => {
      if (tracking !== null) return
      tracking = requestAnimationFrame(() => {
        tracking = null
        if (movingTo.current) return
        const targets = [...(root.current?.querySelectorAll<HTMLElement>('[data-settings-section]') ?? [])]
        const line = scroller.getBoundingClientRect().top + (navigation.current?.getBoundingClientRect().height ?? 0) + 24
        const atEnd = scroller.scrollHeight > scroller.clientHeight && scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2
        const selected = atEnd ? targets.at(-1) : targets.filter(el => el.getBoundingClientRect().top <= line).at(-1) ?? targets[0]
        if (selected?.dataset.settingsSection) setCurrent(selected.dataset.settingsSection)
      })
    }
    const interrupt = (): void => { cancel(); track() }
    const interruptKey = (event: KeyboardEvent): void => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ', 'Escape'].includes(event.key)) interrupt()
    }
    scroller.addEventListener('scroll', track, { passive: true })
    scroller.addEventListener('wheel', interrupt, { passive: true })
    scroller.addEventListener('touchstart', interrupt, { passive: true })
    scroller.addEventListener('pointerdown', interrupt, { passive: true })
    scroller.addEventListener('keydown', interruptKey)
    window.addEventListener('resize', interrupt)
    return () => {
      cancel()
      if (tracking !== null) cancelAnimationFrame(tracking)
      scroller.removeEventListener('scroll', track)
      scroller.removeEventListener('wheel', interrupt)
      scroller.removeEventListener('touchstart', interrupt)
      scroller.removeEventListener('pointerdown', interrupt)
      scroller.removeEventListener('keydown', interruptKey)
      window.removeEventListener('resize', interrupt)
    }
  }, [page, ids])

  // The rail follows the marked section without scrolling the pane.
  useEffect(() => {
    const link = navigation.current?.querySelector<HTMLElement>('[aria-current="location"]')
    const strip = link?.parentElement
    if (!link || !strip) return
    if (link.offsetLeft < strip.scrollLeft) strip.scrollLeft = link.offsetLeft
    else if (link.offsetLeft + link.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = link.offsetLeft + link.offsetWidth - strip.clientWidth
  }, [currentId, page])

  const chooseSection = (event: MouseEvent<HTMLAnchorElement>, id: string): void => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    event.preventDefault()
    handled.current = `${page}:${id}`
    previousPage.current = page
    onNavigate(id)
    showSection(id, event.detail > 0, true)
  }

  if (!available.length) return null

  return (
    <div className="settings-layout" ref={root}>
      <div className="settings-navigation" ref={navigation}>
        <nav className="settings-sections" aria-label={L('Seções de configurações', 'Settings sections')}>
          {available.map(section => (
            <a key={section.id} href={`#settings-${section.id}`} aria-current={currentId === section.id ? 'location' : undefined} onClick={event => chooseSection(event, section.id)}>{section.label}</a>
          ))}
        </nav>
      </div>
      <div className="agent-form settings-content">
        {available.map(section => <section key={section.id} id={`settings-${section.id}`} data-settings-section={section.id} aria-label={section.label} tabIndex={-1}>{content[section.id]}</section>)}
      </div>
    </div>
  )
}
