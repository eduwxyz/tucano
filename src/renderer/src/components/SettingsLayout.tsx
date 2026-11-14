import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { settingsDestination, settingsPages, type SettingsSection, type SettingsSectionId } from '../settings-structure'

export const SETTINGS_SCROLL_MS = 280
export const settingsEase = (t: number): number => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

export function SettingsLayout({ requested, sections, content, onNavigate }: {
  requested?: string
  sections: readonly SettingsSection[]
  content: Record<SettingsSectionId, ReactNode>
  onNavigate: (destination: string) => void
}): ReactNode {
  const destination = settingsDestination(requested, sections)
  const available = sections.filter(s => s.visible && s.page === destination.page)
  const pages = settingsPages().filter(([id]) => sections.some(s => s.visible && s.page === id))
  const root = useRef<HTMLDivElement>(null)
  const navigation = useRef<HTMLDivElement>(null)
  const frame = useRef<number | null>(null)
  const movingTo = useRef<string | null>(null)
  const handled = useRef<string | undefined>(undefined)
  const previousPage = useRef<string | null>(null)
  const [current, setCurrent] = useState<string>(destination.section)
  const currentId = available.some(s => s.id === current) ? current : destination.section
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
  }, [destination.page, ids])

  useLayoutEffect(() => {
    if (handled.current === requested && previousPage.current === destination.page) return
    handled.current = requested
    const changed = previousPage.current !== destination.page
    previousPage.current = destination.page
    cancel()
    if (destination.explicit) showSection(destination.section, false, true)
    else if (changed) {
      const scroller = root.current?.closest<HTMLElement>('.page__scroll')
      if (scroller) scroller.scrollTop = 0
      setCurrent(destination.section)
    }
  }, [requested, destination.page, destination.section, ids])

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
  }, [destination.page, ids])

  // Horizontal navigation follows selection without scrolling the containing page.
  useEffect(() => {
    for (const selector of ['[aria-current="location"]', '[role="tab"][aria-selected="true"]']) {
      const link = navigation.current?.querySelector<HTMLElement>(selector)
      const strip = link?.parentElement
      if (!link || !strip) continue
      if (link.offsetLeft < strip.scrollLeft) strip.scrollLeft = link.offsetLeft
      else if (link.offsetLeft + link.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = link.offsetLeft + link.offsetWidth - strip.clientWidth
    }
  }, [currentId, destination.page])

  const chooseSection = (event: MouseEvent<HTMLAnchorElement>, id: string): void => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    event.preventDefault()
    handled.current = id
    previousPage.current = destination.page
    onNavigate(id)
    showSection(id, event.detail > 0, true)
  }

  return (
    <div className="settings-layout" ref={root}>
      <div className="settings-navigation" ref={navigation}>
        <div className="settings-pages" role="tablist" aria-label={L('Páginas de configurações', 'Settings pages')}>
          {pages.map(([id, label], index) => (
            <button key={id} type="button" id={`settings-tab-${id}`} role="tab" aria-controls={`settings-panel-${id}`} aria-selected={destination.page === id} tabIndex={destination.page === id ? 0 : -1}
              onClick={() => onNavigate(id)} onKeyDown={event => {
                let next: number | undefined
                if (event.key === 'ArrowRight') next = (index + 1) % pages.length
                if (event.key === 'ArrowLeft') next = (index - 1 + pages.length) % pages.length
                if (event.key === 'Home') next = 0
                if (event.key === 'End') next = pages.length - 1
                if (next === undefined) return
                event.preventDefault()
                const id = pages[next]![0]
                onNavigate(id)
                navigation.current?.querySelector<HTMLElement>(`#settings-tab-${id}`)?.focus({ preventScroll: true })
              }}>{label}</button>
          ))}
        </div>
        <nav className="settings-sections" aria-label={L('Seções de configurações', 'Settings sections')}>
          {available.map(section => (
            <a key={section.id} href={`#settings-${section.id}`} aria-current={currentId === section.id ? 'location' : undefined} onClick={event => chooseSection(event, section.id)}>{section.label}</a>
          ))}
        </nav>
      </div>
      {pages.map(([id]) => (
        <div key={id} role="tabpanel" id={`settings-panel-${id}`} aria-labelledby={`settings-tab-${id}`} hidden={destination.page !== id} className="settings-panel">
          {destination.page === id && <div className="agent-form settings-content">
            {available.map(section => <section key={section.id} id={`settings-${section.id}`} data-settings-section={section.id} aria-label={section.label} tabIndex={-1}>{content[section.id]}</section>)}
          </div>}
        </div>
      ))}
    </div>
  )
}
