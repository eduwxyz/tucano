import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

type Item<T extends string> = { id: T; label: ReactNode }

type Props<T extends string> = {
  items: readonly Item<T>[]
  active: T
  onChange: (id: T) => void
  aside?: ReactNode
  variant?: 'hub'
  label?: string
}

export function PageTabs<T extends string>({ items, active, onChange, aside, variant, label }: Props<T>): ReactNode {
  const strip = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const update = (): void => {
    const el = strip.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setEdges((old) => old.left === left && old.right === right ? old : { left, right })
  }
  const reveal = (button: HTMLElement): void => {
    const el = strip.current
    if (!el) return
    const area = el.getBoundingClientRect()
    const target = button.getBoundingClientRect()
    if (target.left < area.left) el.scrollLeft += target.left - area.left
    else if (target.right > area.right) el.scrollLeft += target.right - area.right
    update()
  }
  useEffect(() => {
    const el = strip.current
    if (!el) return
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    const observeChildren = (): void => {
      resize?.disconnect()
      resize?.observe(el)
      Array.from(el.children).forEach((child) => resize?.observe(child))
      update()
    }
    const mutation = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(observeChildren)
    mutation?.observe(el, { childList: true, subtree: true, characterData: true })
    observeChildren()
    window.addEventListener('resize', update)
    return () => { resize?.disconnect(); mutation?.disconnect(); window.removeEventListener('resize', update) }
  }, [])
  useLayoutEffect(() => {
    const selected = strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (selected) reveal(selected)
  }, [active, items.length])
  const keys = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const at = items.findIndex((item) => item.id === active)
    const next = items[(at + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length]
    if (!next) return
    e.preventDefault()
    onChange(next.id)
    const button = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[(at + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length]
    button?.focus({ preventScroll: true })
    if (button) reveal(button)
  }
  return (
    <div className={variant === 'hub' ? 'page-tabs hub__tabs' : 'page-tabs tabs'}>
      <div className={`page-tabs__viewport${edges.left ? ' has-left' : ''}${edges.right ? ' has-right' : ''}`}>
        <div className="page-tabs__strip" role="tablist" aria-label={label} ref={strip} onScroll={update} onKeyDown={keys}>
          {items.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={active === item.id} tabIndex={active === item.id ? 0 : -1}
              className={`${variant === 'hub' ? 'hub__tab ' : ''}${active === item.id ? 'is-active' : ''}`}
              onClick={() => onChange(item.id)} onFocus={(e) => reveal(e.currentTarget)}>
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {aside && <span className="tabs__aside">{aside}</span>}
    </div>
  )
}
