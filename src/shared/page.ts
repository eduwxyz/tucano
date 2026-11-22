// What an agent's browser runs inside a page (spec §24), the same in Chrome and in
// Electron's Chromium: the numbered elements, where to click one, the text.
import { L } from './lang'

// A saved password typed by navegador_login is kept in our isolated world (the page can't read it
// there) only so it never comes back out: a field holding it is shown as dots, even after the page's
// "show password" turned it to text or swapped the field for a new one, and the page's text masks it.
const SECRETS = `const secrets = window.__adSecrets || []
  const secretIn = (v) => !!v && secrets.some((s) => v.includes(s))
  const hideSecrets = () => { if (!secrets.length) return; const walk = (root) => { for (const f of root.querySelectorAll('input')) { if (f.type !== 'password' && secretIn(f.value)) f.type = 'password' } for (const e of root.querySelectorAll('*')) if (e.shadowRoot) walk(e.shadowRoot) }; walk(document) }`

// Before a picture of the screen: a saved password shown as text goes back to dots.
export const HIDE_SECRETS = `(() => { ${SECRETS}
  hideSecrets()
  return true
})()`

// What can be clicked or filled, numbered, inside shadow roots too.
export const SNAPSHOT = `(() => { ${SECRETS}
  hideSecrets()
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
    if (secretIn(label)) label = '••••'
    let value
    if (tag === 'select') value = clean(el.selectedOptions[0] && el.selectedOptions[0].text)
    else if (field && !el.isContentEditable) value = type === 'password' || secretIn(el.value) ? (el.value ? '••••' : '') : clean(el.value).slice(0, 80)
    else if (el.isContentEditable) value = clean(el.innerText).slice(0, 80)
    const c = el.checked !== undefined && (type === 'checkbox' || type === 'radio') ? el.checked : el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' ? true : undefined
    refs.push(new WeakRef(el))
    const submits = field && tag === 'input' ? sender(el) : undefined
    out.push({ ref: refs.length, role, label: once(label).slice(0, 100), value: value || undefined, checked: c, disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' || undefined, inView: r.bottom > 0 && r.right > 0 && r.top < H && r.left < W, focused: el === active || undefined, multiline: (field && (tag === 'textarea' || el.isContentEditable)) || undefined, submits: submits === undefined ? undefined : submits.slice(0, 100) })
  }
  window.__adRefs = refs
  // What the page is when it isn't the page (shared/wall.ts): the start of its visible words, how
  // much of it there is, and the marks a bot check leaves. It stops at the cap, so a long page
  // costs about as much as a short one, and a wall's own words are all inside the sample.
  const CAP = 1200, SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG'])
  let sample = '', more = false
  const walkText = (node) => {
    for (const c of (node.shadowRoot || node).childNodes) {
      if (sample.length >= CAP) { more = true; return }
      if (c.nodeType === 3) { const t = c.data.replace(/\\s+/g, ' ').trim(); if (t) sample += t + ' ' }
      else if (c.nodeType === 1 && !SKIP.has(c.tagName)) { if (c.checkVisibility && !c.checkVisibility()) continue; walkText(c) }
    }
  }
  if (document.body) walkText(document.body)
  let words = sample.replace(/\\s+/g, ' ').trim().slice(0, CAP).toLowerCase()
  for (const s of secrets) if (s.length >= 4) words = words.split(s.toLowerCase()).join('••••')
  const count = (role) => out.filter((e) => e.role === role).length
  const marks = []
  for (const m of ['challenge-form', 'challenge-stage', 'cf-turnstile', 'g-recaptcha', 'h-captcha', 'px-captcha', 'datadome']) if (document.querySelector('#' + m + ', .' + m)) marks.push(m)
  const signs = {
    chars: words.length,
    more,
    words,
    links: count('link'),
    fields: count('campo'),
    buttons: count('botão'),
    password: [...document.querySelectorAll('input[type=password]')].filter((i) => !i.checkVisibility || i.checkVisibility()).length,
    frames: [...document.querySelectorAll('iframe')].map((f) => (f.getAttribute('src') || '').toLowerCase()).filter(Boolean).slice(0, 8),
    marks
  }
  return { url: location.href, title: document.title, w: W, h: H, scrollY: Math.round(scrollY), scrollH: document.documentElement.scrollHeight, elements: out, signs }
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

// A field of the last snapshot about to take a saved login, or why not: the page must be on the
// exact origin the login was saved for, and a password goes only into a password field. With focus,
// the field is focused and selected (what's there gets replaced) and a password is remembered as
// one, to be masked from then on (SECRETS above).
export const FILL = (ref: number, origin: string, password: boolean, focus: boolean, secret = ''): string => `(() => {
  if (location.origin !== ${JSON.stringify(origin)}) return 'origin'
  const el = window.__adRefs && window.__adRefs[${ref - 1}] && window.__adRefs[${ref - 1}].deref()
  if (!el || !el.isConnected) return 'gone'
  const type = (el.getAttribute('type') || 'text').toLowerCase()
  if (el.tagName !== 'INPUT' || el.disabled || el.readOnly) return 'field'
  if (${password} ? type !== 'password' : !['text', 'email', 'tel', 'number', 'search', 'url'].includes(type)) return ${password} ? 'password' : 'field'
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const r = el.getBoundingClientRect()
  if (${focus}) {
    ${secret ? `window.__adSecrets = (window.__adSecrets || []).filter((s) => s !== ${JSON.stringify(secret)}).concat(${JSON.stringify(secret)})` : ''}
    el.focus()
    el.select()
  }
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})()`

// Why FILL said no, for the agent: never the text it was going to type.
export const fillRefused = (why: string): string =>
  ({
    origin: L('A página mudou de endereço: o login salvo não foi digitado.', 'The page changed address: the saved login was not typed.'),
    gone: L('Esse campo não está mais na página. Leia a página de novo.', 'That field is no longer on the page. Read the page again.'),
    password: L('Esse não é um campo de senha: a senha salva só entra num campo de senha.', 'That is not a password field: the saved password only goes into a password field.'),
    field: L('Esse não é um campo de usuário ou email.', 'That is not a username or email field.')
  })[why] ?? L('O login salvo não foi digitado.', 'The saved login was not typed.')

// The text a person reads on the page, shadow roots included, line by block.
export const TEXT = `(() => { ${SECRETS}
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
  let text = out.join('').replace(/ +\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim()
  for (const s of secrets) if (s.length >= 4) text = text.split(s).join('••••')
  return text
})()`
