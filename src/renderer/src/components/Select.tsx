// A reusable, shadcn-style select input: optional inline filtering (typing when
// open), single or multi selection (checkbox on the left, accent check mark),
// optional grouping as `{ 'group name': { value: 'label', ... } }`, full keyboard
// control (arrows move focus, enter selects, Esc closes, typeahead on a closed
// trigger jumps to the first match), click-outside/Esc to close, and
// accessibility. The menu renders in a portal at `document.body`, anchored to
// the trigger with fixed coordinates (flips above when there's no room below,
// follows scroll/resize).
//
// Flat options (strings mean value === label):
//   <Select options={['a', 'b']} value={v} onChange={setV} />
//   <Select options={[{ value: 'x', label: 'Label of x' }]} />
//
// Grouped options:
//   <Select groups={{ 'Meu grupo 1': { x: 'Label of x', y: 'Label of y' } }} />
//
// Multi-select:
//   <Select multiple options={['a','b']} values={['a']} onValuesChange={setVs} />
//
// With filter box:
//   <Select options={bigList} searchable />
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { L } from '../../../shared/lang'
import { Icon } from './ui'

const fold = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

type SelectOption = { value: string; label: string; hint?: string }

type SelectProps = {
  id?: string
  name?: string
  label?: string
  hint?: string
  // Flat list: strings (value === label) or { value, label } objects.
  options?: (string | SelectOption)[]
  // Grouped options: { 'group name': { value: 'label to show', ... } }.
  groups?: Record<string, Record<string, string>>
  placeholder?: string
  // Single select value.
  value?: string | null
  // Multi select values.
  values?: string[]
  onChange?: (value: string | null) => void
  onValuesChange?: (values: string[]) => void
  multiple?: boolean
  // Show the filter (type-ahead) input when the menu opens.
  searchable?: boolean
  // Show a small secondary hint line under each option's label.
  showHint?: boolean
  disabled?: boolean
  required?: boolean
  // Accessible label override; defaults to `label`.
  'aria-label'?: string
  // Whether the menu is open (controlled). When omitted the menu is uncontrolled.
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
  // Empty-state text when nothing matches the filter.
  emptyText?: string
}

type Item = {
  value: string
  label: string
  hint?: string
  group?: string
  groupIndex?: number
  // Folded label, computed once, for filtering and typeahead.
  key: string
}

const normalize = (o: string | SelectOption): SelectOption =>
  typeof o === 'string' ? { value: o, label: o } : o

// "provider:model" reads better as "provider: model" in a group title.
const groupTitle = (s: string): string => s.replace(/:(?=\S)/g, ': ')

const resolveItems = (
  options: SelectProps['options'],
  groups: SelectProps['groups']
): Item[] => {
  const items: Item[] = []
  if (groups) {
    Object.entries(groups).forEach(([groupLabel, inner], gi) => {
      const group = groupTitle(groupLabel)
      for (const [value, label] of Object.entries(inner)) items.push({ value, label, group, groupIndex: gi, key: fold(label) })
    })
    return items
  }
  for (const o of (options ?? []).map(normalize)) items.push({ value: o.value, label: o.label, hint: o.hint, key: fold(o.label) })
  return items
}

// Gap between trigger and menu, and minimum distance from the window edge.
const GAP = 6
const MARGIN = 8
const PREFERRED_HEIGHT = 300
// Below this much room on either side, the menu overlays the trigger instead.
const MIN_HEIGHT = 96

type MenuPosition = { top?: number; bottom?: number; left: number; width: number; maxHeight: number; placement: 'top' | 'bottom' | 'over' }

const samePosition = (a: MenuPosition | null, b: MenuPosition): boolean =>
  !!a && a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.width === b.width && a.maxHeight === b.maxHeight && a.placement === b.placement

type OptionProps = {
  item: Item
  index: number
  domId: string
  active: boolean
  selected: boolean
  multiple: boolean
  showHint: boolean
  onPick: (value: string) => void
  onHover: (index: number) => void
}

// Memoized so moving the highlight re-renders two options, not the whole list.
const SelectOptionRow = memo(function SelectOptionRow({ item, index, domId, active, selected, multiple, showHint, onPick, onHover }: OptionProps): ReactNode {
  return (
    <button
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      id={domId}
      className={`select__option${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}`}
      onClick={(e) => { e.preventDefault(); onPick(item.value) }}
      onMouseMove={() => { if (!active) onHover(index) }}
    >
      {multiple && (
        <span className={`select__check${selected ? ' is-on' : ''}`} aria-hidden>
          {selected && <Icon name="check" size={12} />}
        </span>
      )}
      <span className="select__option__text">
        <span className="select__label">{item.label}</span>
        {showHint && item.hint && <span className="select__hint">{item.hint}</span>}
      </span>
      {!multiple && selected && <span className="select__tick" aria-hidden><Icon name="check" size={13} /></span>}
    </button>
  )
})

export function Select(props: SelectProps): ReactNode {
  const {
    id, name, label, hint, options, groups,
    placeholder = '', value, values, onChange, onValuesChange,
    multiple = false, searchable = false, showHint = false, disabled = false, required = false,
    'aria-label': ariaLabelProp, open: openProp, onOpenChange,
    className = '', emptyText = L('Nenhuma correspondência', 'No matches')
  } = props
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [selectedValue, setSelectedValue] = useState<string | null>(value ?? null)
  const [selectedValues, setSelectedValues] = useState<string[]>(values ?? [])

  useEffect(() => { setSelectedValue(value ?? null) }, [value])
  useEffect(() => { setSelectedValues(values ?? []) }, [values])

  // Derived data, recomputed only when the inputs change.
  const items = useMemo(() => resolveItems(options, groups), [options, groups])
  const labels = useMemo(() => new Map(items.map((it) => [it.value, it.label])), [items])
  const q = fold(query.trim())
  const filteredItems = useMemo(() => (q ? items.filter((it) => it.key.includes(q)) : items), [items, q])
  const selectedSet = useMemo(() => new Set(multiple ? selectedValues : selectedValue != null ? [selectedValue] : []), [multiple, selectedValues, selectedValue])
  const matchCount = filteredItems.length
  const last = Math.max(0, matchCount - 1)
  const activeIndex = Math.min(highlight, last)
  const highlightedItem = filteredItems[activeIndex]

  const setOpen = useCallback((next: boolean) => {
    if (openProp === undefined) setOpenState(next)
    onOpenChange?.(next)
  }, [openProp, onOpenChange])
  const close = useCallback(() => setOpen(false), [setOpen])
  const openMenu = useCallback(() => { if (!disabled) setOpen(true) }, [disabled, setOpen])

  // Place the menu next to the trigger, in viewport coordinates, never past the window edges.
  const place = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const r = trigger.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    // The trigger left the screen (scrolled away): close instead of floating a detached menu.
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) { close(); return }
    const below = vh - r.bottom - GAP - MARGIN
    const above = r.top - GAP - MARGIN
    const wanted = Math.min(menuRef.current?.scrollHeight ?? PREFERRED_HEIGHT, PREFERRED_HEIGHT)
    const width = Math.max(0, Math.min(Math.max(r.width, 180), vw - MARGIN * 2))
    const left = Math.round(Math.min(Math.max(MARGIN, r.left), vw - width - MARGIN))
    let next: MenuPosition
    if (below >= wanted || (below >= above && below >= MIN_HEIGHT))
      next = { left, width, top: Math.round(r.bottom + GAP), maxHeight: Math.floor(Math.min(below, PREFERRED_HEIGHT)), placement: 'bottom' }
    else if (above >= MIN_HEIGHT)
      next = { left, width, bottom: Math.round(vh - r.top + GAP), maxHeight: Math.floor(Math.min(above, PREFERRED_HEIGHT)), placement: 'top' }
    else {
      // A very short window: use the whole height, over the trigger.
      const h = Math.max(0, Math.min(vh - MARGIN * 2, PREFERRED_HEIGHT))
      next = { left, width, top: Math.round(Math.max(MARGIN, Math.min(r.top, vh - MARGIN - h))), maxHeight: Math.floor(h), placement: 'over' }
    }
    setPosition((prev) => (samePosition(prev, next) ? prev : next))
  }, [close])

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return }
    place()
    // Coalesce scroll/resize bursts into one measurement per frame.
    let frame = 0
    const schedule = (): void => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; place() }) }
    const onScroll = (e: Event): void => {
      // Scrolling inside the menu itself shouldn't re-place it.
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return
      schedule()
    }
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    const ro = new ResizeObserver(schedule)
    if (triggerRef.current) ro.observe(triggerRef.current)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', onScroll, { capture: true })
      ro.disconnect()
    }
  }, [open, place])

  // Re-place when the content height changes (filtering).
  useLayoutEffect(() => { if (open) place() }, [open, matchCount, place])

  // On open: reset the filter, highlight the current value, move focus into the menu.
  useEffect(() => {
    if (!open) return
    setQuery('')
    const current = multiple ? selectedValues[0] : selectedValue
    const idx = current != null ? items.findIndex((it) => it.value === current) : -1
    setHighlight(idx === -1 ? 0 : idx)
    const frame = requestAnimationFrame(() => {
      if (searchable) inputRef.current?.focus()
      else listRef.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, searchable])

  // Keep the highlighted option visible, below the sticky group title.
  useEffect(() => {
    if (!open) return
    const list = listRef.current
    const el = list?.querySelector<HTMLElement>('.select__option.is-active')
    if (!list || !el) return
    const header = groups ? list.querySelector<HTMLElement>('.select__group')?.offsetHeight ?? 0 : 0
    const top = el.offsetTop - header
    const bottom = el.offsetTop + el.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }, [open, activeIndex, position, groups])

  // Click outside closes the menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e: Event): void => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return
      close()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, close])

  // Stable pick handler for the memoized rows; reads the latest state through a ref.
  const latest = useRef({ multiple, selectedValues, onChange, onValuesChange, close })
  latest.current = { multiple, selectedValues, onChange, onValuesChange, close }
  const toggleItem = useCallback((v: string): void => {
    const { multiple: m, selectedValues: cur, onChange: oc, onValuesChange: ovc, close: cl } = latest.current
    if (m) {
      const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]
      setSelectedValues(next)
      ovc?.(next)
    } else {
      setSelectedValue(v)
      oc?.(v)
      cl()
      triggerRef.current?.focus()
    }
  }, [])

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (open) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); openMenu(); return }
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      openMenu()
      const ch = fold(e.key)
      const idx = items.findIndex((it) => it.key.startsWith(ch))
      if (idx !== -1) setTimeout(() => setHighlight(idx), 0)
    }
  }

  // Keyboard inside the open menu (filter input or list).
  const onMenuKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, last)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(Math.min(h, last) - 1, 0)); return }
    if (e.key === 'Home') { e.preventDefault(); setHighlight(0); return }
    if (e.key === 'End') { e.preventDefault(); setHighlight(last); return }
    if (e.key === 'PageDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 8, last)); return }
    if (e.key === 'PageUp') { e.preventDefault(); setHighlight((h) => Math.max(Math.min(h, last) - 8, 0)); return }
    if (e.key === 'Enter' || (e.key === ' ' && !searchable)) { e.preventDefault(); if (highlightedItem) toggleItem(highlightedItem.value); return }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); triggerRef.current?.focus(); return }
    if (e.key === 'Tab') { close(); return }
    if (!searchable && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const ch = fold(e.key)
      const idx = filteredItems.findIndex((it) => it.key.startsWith(ch))
      if (idx !== -1) setHighlight(idx)
    }
  }

  // Each select its own ids, so two on a page don't share options, lists or menus.
  const ownId = useId()
  const idBase = id ?? `select${ownId.replace(/:/g, '')}`
  const optionId = (i: number): string => `${idBase}-option-${i}`

  const renderRow = (it: Item, i: number): ReactNode => (
    <SelectOptionRow
      key={`${it.groupIndex ?? 0}-${it.value}`}
      item={it}
      index={i}
      domId={optionId(i)}
      active={i === activeIndex}
      selected={selectedSet.has(it.value)}
      multiple={multiple}
      showHint={showHint}
      onPick={toggleItem}
      onHover={setHighlight}
    />
  )

  // Each group is its own section so its title sticks only while its options scroll by.
  const renderList = (): ReactNode => {
    if (!groups) return filteredItems.map(renderRow)
    const sections: { key: number; title: string; rows: ReactNode[] }[] = []
    filteredItems.forEach((it, i) => {
      let s = sections[sections.length - 1]
      if (!s || s.key !== it.groupIndex) { s = { key: it.groupIndex ?? 0, title: it.group ?? '', rows: [] }; sections.push(s) }
      s.rows.push(renderRow(it, i))
    })
    return sections.map((s) => (
      <div key={s.key} className="select__section" role="group" aria-label={s.title}>
        <div className="select__group" aria-hidden>{s.title}</div>
        {s.rows}
      </div>
    ))
  }

  const display = (): ReactNode => {
    if (multiple) {
      if (selectedValues.length === 0) return <span className="select__placeholder">{placeholder}</span>
      if (selectedValues.length <= 3) return selectedValues.map((v) => <span key={v} className="select__chip">{labels.get(v) ?? v}</span>)
      return <span className="select__chip">{L(`${selectedValues.length} selecionados`, `${selectedValues.length} selected`)}</span>
    }
    // An option whose value is '' ("the usual one") shows as itself, like any other.
    return selectedValue != null && labels.has(selectedValue) ? <span className="select__value">{labels.get(selectedValue)}</span> : selectedValue ? <span className="select__value">{selectedValue}</span> : <span className="select__placeholder">{placeholder}</span>
  }

  const menuId = `${idBase}-menu`
  const listId = `${idBase}-list`
  const accessibleName = ariaLabelProp ?? label ?? undefined
  const menuStyle: CSSProperties = position
    ? { top: position.top, bottom: position.bottom, left: position.left, width: position.width, maxHeight: position.maxHeight }
    : { visibility: 'hidden', top: 0, left: 0 }

  return (
    <div className={`select ${className}`}>
      {label && (
        <label className="field__label" htmlFor={id || undefined}>
          {label}{required && <span className="field__required" aria-hidden> *</span>}
        </label>
      )}
      <button
        ref={triggerRef}
        id={id}
        name={name}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && highlightedItem ? optionId(activeIndex) : undefined}
        aria-label={accessibleName}
        aria-required={required}
        aria-disabled={disabled || undefined}
        className={`select__trigger ${open ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''}`}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="select__trigger__value">{display()}</span>
        <span className="select__caret" aria-hidden><Icon name="caret" size={14} /></span>
      </button>
      {hint && <span className="hint">{hint}</span>}
      {open && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="select__menu"
          data-placement={position?.placement ?? 'bottom'}
          style={menuStyle}
          onMouseDown={(e) => { if (e.target !== inputRef.current) e.preventDefault() }}
          onKeyDown={onMenuKeyDown}
        >
          {searchable && (
            <div className="select__search">
              <span className="select__search__icon"><Icon name="search" size={14} /></span>
              <input
                ref={inputRef}
                type="text"
                aria-controls={listId}
                aria-label={L('Filtrar opções', 'Filter options')}
                placeholder={L('Filtrar…', 'Filter…')}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setHighlight(0) }}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}
          <div
            ref={listRef}
            role="listbox"
            id={listId}
            aria-label={accessibleName}
            aria-multiselectable={multiple || undefined}
            className="select__list"
            tabIndex={-1}
          >
            {matchCount === 0
              ? <div className="select__empty" role="status" aria-live="polite">{emptyText}</div>
              : renderList()}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
