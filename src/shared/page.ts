// What an agent's browser runs inside a page (spec §24), the same in Chrome and in
// Electron's Chromium: the numbered elements, where to click one, the text.

// What can be clicked or filled, numbered, inside shadow roots too.
export const SNAPSHOT = `(() => {
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=menuitem],[role=menuitemcheckbox],[role=option],[role=combobox],[role=switch],[role=textbox],[role=searchbox],[role=slider],[contenteditable=""],[contenteditable=true],[onclick]'
  const found = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.matches(SEL)) found.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const W = innerWidth, H = innerHeight, refs = [], out = []
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim()
  // "Tudo Tudo": a visible label and a hidden copy for screen readers.
  const once = (s) => { const w = s.split(' '); const h = w.length / 2; return w.length % 2 === 0 && w.slice(0, h).join(' ') === w.slice(h).join(' ') ? w.slice(0, h).join(' ') : s }
  const ROLES = { button: 'botão', tab: 'aba', menuitem: 'item de menu', menuitemcheckbox: 'item de menu', option: 'opção', combobox: 'campo', textbox: 'campo', searchbox: 'campo', switch: 'chave', slider: 'controle' }
  // The element that has the focus, inside shadow roots too.
  let active = document.activeElement
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement
  // What a field's form sends with: its submit button's label (Enter in the field presses it).
  const sender = (f) => {
    const form = f.form || (f.closest && f.closest('form'))
    if (!form) return undefined
    const b = form.querySelector('button:not([type]),button[type=submit],input[type=submit],input[type=image]')
    if (!b) return ''
    return clean(b.getAttribute('aria-label')) || clean(b.innerText) || clean(b.value) || clean(b.getAttribute('title')) || clean(b.getAttribute('alt'))
  }
  const byIds = (ids) => clean((ids || '').split(/\\s+/).map((id) => { const n = id && (el.getRootNode().getElementById ? el.getRootNode() : document).getElementById(id); return n ? n.innerText || n.textContent : '' }).join(' '))
  let el
  for (el of found) {
    const r = el.getBoundingClientRect()
    if (r.width < 3 || r.height < 3) continue
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
    const tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase()
    const field = tag === 'textarea' || (tag === 'input' && !['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) || el.isContentEditable
    const aria = el.getAttribute('role')
    const role = (aria && (ROLES[aria] || aria)) || (tag === 'a' ? 'link' : tag === 'select' ? 'lista' : field ? 'campo' : tag === 'input' && (type === 'checkbox' || type === 'radio') ? type : 'botão')
    let label = clean(el.getAttribute('aria-label')) || byIds(el.getAttribute('aria-labelledby')) || clean(el.getAttribute('title'))
    if (!label && field) label = clean(el.labels && el.labels[0] && el.labels[0].innerText) || clean(el.getAttribute('placeholder')) || clean(el.getAttribute('name'))
    if (!label && !field) label = clean(el.innerText) || clean(el.getAttribute('alt')) || clean(el.querySelector && el.querySelector('img[alt]') && el.querySelector('img[alt]').alt) || clean(el.value)
    let value
    if (tag === 'select') value = clean(el.selectedOptions[0] && el.selectedOptions[0].text)
    else if (field && !el.isContentEditable) value = type === 'password' ? (el.value ? '••••' : '') : clean(el.value).slice(0, 80)
    else if (el.isContentEditable) value = clean(el.innerText).slice(0, 80)
    const c = el.checked !== undefined && (type === 'checkbox' || type === 'radio') ? el.checked : el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' ? true : undefined
    refs.push(new WeakRef(el))
    const submits = field && tag === 'input' ? sender(el) : undefined
    out.push({ ref: refs.length, role, label: once(label).slice(0, 100), value: value || undefined, checked: c, disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' || undefined, inView: r.bottom > 0 && r.right > 0 && r.top < H && r.left < W, focused: el === active || undefined, multiline: (field && (tag === 'textarea' || el.isContentEditable)) || undefined, submits: submits === undefined ? undefined : submits.slice(0, 100) })
  }
  window.__adRefs = refs
  return { url: location.href, title: document.title, w: W, h: H, scrollY: Math.round(scrollY), scrollH: document.documentElement.scrollHeight, elements: out }
})()`

// Where to click an element of the last snapshot, brought into view first.
export const POINT = (ref: number, focus: boolean): string => `(() => {
  const el = window.__adRefs && window.__adRefs[${ref - 1}] && window.__adRefs[${ref - 1}].deref()
  if (!el || !el.isConnected) return null
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const r = el.getBoundingClientRect()
  if (${focus}) {
    el.focus()
    if (el.select) el.select()
    else if (el.isContentEditable) getSelection().selectAllChildren(el)
  }
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, select: el.tagName === 'SELECT' }
})()`

// A <select> takes the option whose text matches, like a person picking it.
export const PICK = (ref: number, text: string): string => `(() => {
  const el = window.__adRefs[${ref - 1}].deref(), want = ${JSON.stringify(text.toLowerCase())}
  const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === want) || [...el.options].find((o) => o.text.toLowerCase().includes(want))
  if (!opt) return [...el.options].map((o) => o.text.trim())
  el.value = opt.value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`

// The text a person reads on the page, shadow roots included, line by block.
export const TEXT = `(() => {
  const out = [], SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'SVG'])
  const walk = (node) => {
    for (const c of (node.shadowRoot || node).childNodes) {
      if (c.nodeType === 3) { const t = c.data.replace(/\\s+/g, ' ').trim(); if (t) out.push(t + ' ') }
      else if (c.nodeType === 1 && !SKIP.has(c.tagName)) {
        if (c.checkVisibility && !c.checkVisibility()) continue
        const d = getComputedStyle(c).display
        const block = d !== 'inline' && d !== 'contents' && d !== 'inline-block'
        if (block) out.push('\\n')
        walk(c)
        if (block) out.push('\\n')
      }
    }
  }
  walk(document.body)
  return out.join('').replace(/ +\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim()
})()`
