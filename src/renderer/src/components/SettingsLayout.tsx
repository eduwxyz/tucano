import { createContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { settingsGroupLabel, type SettingsHit, type SettingsPageId, type SettingsSection } from '../settings-structure'
import { Icon, type IconName } from './ui'

export const SETTINGS_SCROLL_MS = 280
export const settingsEase = (t: number): number => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

// The name of the subject a card is drawn in. A card inside a subject is one of its groups: its
// title is the small heading over the group, and a title that only repeats the subject's is left out.
export const SettingsSubjectTitle = createContext<string | null>(null)

// The tile by a subject's name, the same in its heading, the jump row and a search result.
export function SettingsTile({ section, size = 'md' }: { section: SettingsSection; size?: 'sm' | 'md' }): ReactNode {
  return (
    <span className={`settings-tile settings-tile--${size}`} style={{ background: section.color }} aria-hidden>
      <Icon name={section.icon as IconName} size={size === 'sm' ? 11 : 15} />
    </span>
  )
}

// One subject of a group: its tile and name, then its cards as groups of rows. The page scrolls to
// it from the jump row and from a search result, so it carries the anchor and takes the focus.
export function SettingsSubject({ section, children }: { section: SettingsSection; children: ReactNode }): ReactNode {
  return (
    <section className="settings-subject" id={`settings-${section.id}`} data-settings-section={section.id} aria-labelledby={`settings-${section.id}-title`} tabIndex={-1}>
      <header className="settings-subject__head">
        <SettingsTile section={section} />
        <h2 id={`settings-${section.id}-title`}>{section.label}</h2>
      </header>
      <SettingsSubjectTitle.Provider value={section.label}>{children}</SettingsSubjectTitle.Provider>
    </section>
  )
}

// The five groups, as one segmented control: picking one shows its subjects in place of the others.
export function SettingsGroups({ groups, current, onPick }: { groups: readonly SettingsPageId[]; current: string | null; onPick: (group: SettingsPageId) => void }): ReactNode {
  return (
    <div className="settings-groups">
      <div className="settings-groups__bar" role="tablist" aria-label={L('Grupos de configurações', 'Settings groups')}>
        {groups.map((group) => (
          <button key={group} type="button" role="tab" aria-selected={current === group} className={current === group ? 'is-active' : ''} onClick={() => onPick(group)}>
            {settingsGroupLabel(group)}
          </button>
        ))}
      </div>
    </div>
  )
}

// Under the groups, one link per subject of the open group, to go straight to it. A pointer click
// glides there over an interruptible 280 ms ease-in-out; a keyboard activation and a reduced-motion
// preference move at once; wheel, touch, pointer or key input, or another link, stops a glide. The
// subject it lands on takes the focus without a second scroll. Only subjects the page really drew get
// a link, so a subject this person's role leaves out is never a dead anchor.
export function SettingsJumps({ sections }: { sections: readonly SettingsSection[] }): ReactNode {
  const [present, setPresent] = useState<readonly string[] | null>(null)
  const listed = sections.filter((section) => section.visible)
  const available = present ? listed.filter((section) => present.includes(section.id)) : listed
  const root = useRef<HTMLElement>(null)
  const frame = useRef<number | null>(null)
  const ids = listed.map((section) => section.id).join('|')

  const cancel = (): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    root.current?.removeAttribute('data-settings-scrolling')
  }

  useLayoutEffect(() => {
    const scroller = root.current?.closest<HTMLElement>('.page__scroll')
    if (!scroller) return
    const drawn = new Set(Array.from(scroller.querySelectorAll<HTMLElement>('[data-settings-section]')).map((element) => element.dataset.settingsSection))
    const seen = listed.map((section) => section.id).filter((id) => drawn.has(id))
    setPresent((previous) => (previous && previous.join('|') === seen.join('|') ? previous : seen))
  }, [ids])

  useEffect(() => {
    const scroller = root.current?.closest<HTMLElement>('.page__scroll')
    if (!scroller) return
    const interruptKey = (event: KeyboardEvent): void => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ', 'Escape'].includes(event.key)) cancel()
    }
    scroller.addEventListener('wheel', cancel, { passive: true })
    scroller.addEventListener('touchstart', cancel, { passive: true })
    scroller.addEventListener('pointerdown', cancel, { passive: true })
    scroller.addEventListener('keydown', interruptKey)
    window.addEventListener('resize', cancel)
    return () => {
      cancel()
      scroller.removeEventListener('wheel', cancel)
      scroller.removeEventListener('touchstart', cancel)
      scroller.removeEventListener('pointerdown', cancel)
      scroller.removeEventListener('keydown', interruptKey)
      window.removeEventListener('resize', cancel)
    }
  }, [ids])

  const go = (event: MouseEvent<HTMLAnchorElement>, id: string): void => {
    // A modified click belongs to the person's browser, not to this row.
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    event.preventDefault()
    cancel()
    const scroller = root.current?.closest<HTMLElement>('.page__scroll')
    if (!scroller) return
    // A keyboard activation arrives with no click count, and it moves at once.
    glideTo(scroller, id, event.detail > 0, frame, () => root.current?.setAttribute('data-settings-scrolling', id), () => root.current?.removeAttribute('data-settings-scrolling'))
  }

  if (available.length < 2) return null
  return (
    <nav className="settings-jumps" aria-label={L('Ir para', 'Go to')} ref={root}>
      {available.map((section) => (
        <a key={section.id} href={`#settings-${section.id}`} onClick={(event) => go(event, section.id)}>
          <SettingsTile section={section} size="sm" />
          {section.label}
        </a>
      ))}
    </nav>
  )
}

// Takes the page to a subject: it parks under the sticky settings header, which stays at the top while
// the page scrolls, and the subject takes the focus without a second scroll.
export function glideTo(scroller: HTMLElement, id: string, animated: boolean, frame: { current: number | null }, began?: () => void, ended?: () => void): void {
  const target = scroller.querySelector<HTMLElement>(`[data-settings-section="${id}"]`)
  if (!target) return
  // How far down the header ends once it's parked: its height plus where it parks (below a drag strip).
  const sticky = scroller.querySelector<HTMLElement>('.settings-sticky') ?? scroller.querySelector<HTMLElement>('.settings-groups')
  const bar = sticky ? sticky.getBoundingClientRect().height + (parseFloat(window.getComputedStyle?.(sticky).top ?? '') || 0) : 0
  const destination = (): number => Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight,
    scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - bar - 16))
  target.focus({ preventScroll: true })
  const start = scroller.scrollTop
  const top = destination()
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (!animated || reduced || Math.abs(top - start) < 1) {
    scroller.scrollTop = top
    return
  }
  began?.()
  let first: number | null = null
  const step = (at: number): void => {
    first ??= at
    const progress = Math.min(1, (at - first) / SETTINGS_SCROLL_MS)
    scroller.scrollTop = start + (destination() - start) * settingsEase(progress)
    if (progress < 1) frame.current = requestAnimationFrame(step)
    else {
      frame.current = null
      ended?.()
    }
  }
  frame.current = requestAnimationFrame(step)
}

// The search's answer, in place of the group: one row per place a word was found, with the group and
// subject it is in. Picking one opens that group at that subject.
export function SettingsResults({ hits, query, onPick }: { hits: readonly SettingsHit[]; query: string; onPick: (section: SettingsSection) => void }): ReactNode {
  if (hits.length === 0)
    return <p className="settings-results__none">{L(`Nada com “${query.trim()}”. Tente outra palavra, como “limite”, “modelo” ou “som”.`, `No results for “${query.trim()}”. Try “limit”, “model” or “sound”.`)}</p>
  return (
    <div className="settings-results" role="list" aria-label={L('Resultados da busca', 'Search results')}>
      {hits.map((hit, i) => (
        <button key={`${hit.section.id}-${i}`} type="button" role="listitem" className="settings-results__row" onClick={() => onPick(hit.section)}>
          <SettingsTile section={hit.section} />
          <span className="grow">
            <strong>{hit.term}</strong>
            <span>{settingsGroupLabel(hit.section.page)} › {hit.section.label}</span>
          </span>
          <Icon name="chevron" size={14} />
        </button>
      ))}
    </div>
  )
}
