// The thinking block never makes the conversation scroll sideways: a path or an address in the model's
// reasoning has no space to break at, so it has to wrap. In a thread the column is at its narrowest
// (`.side-panel--thread` is min(42%, 560px) with a 360px floor), which is where it used to show.
// Layout needs a browser: linkedom has no scrollWidth.
import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

const CSS = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
// A token with nowhere to break: the shape a thought takes when it reads a path or a link.
const LONG = 'C:\\git-ext\\tucano\\src\\renderer\\src\\components\\Conversation.tsx:11799:thinking'

const markup = (working: boolean): string => `
  <style>${CSS}</style>
  <div id="panel" class="side-panel side-panel--thread">
    <div class="messages">
      <article class="msg msg--agent">
        <div class="msg__gutter"></div>
        <div class="msg__body">
          <div class="msg__head"><span class="msg__author">Tuca</span></div>
          <div class="steps is-open${working ? ' is-working' : ''}">
            <div class="thought is-open${working ? ' is-working' : ''}">
              <button type="button" class="thought__head" aria-expanded="true">
                <span class="thought__label">${working ? 'Thinking' : 'Thought'}</span>
              </button>
              <div class="thought__text">${`Checking ${LONG} before the next step, because the word has to be whole.`}</div>
            </div>
          </div>
          <div class="md"><p>Here is the answer.</p></div>
        </div>
      </article>
    </div>
  </div>`

it.skipIf(!existsSync(chromium.executablePath()))('wraps a word with no space in it, so a thread never scrolls sideways', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    // The arriving block scrolls itself; the finished one sits in the page, where it used to push the
    // whole thread sideways. Both are measured at the panel's 360px floor and at its 420px default.
    for (const working of [true, false]) {
      for (const width of [360, 420]) {
        await page.setViewportSize({ width: width + 200, height: 800 })
        await page.setContent(markup(working))
        await page.addStyleTag({ content: `#panel { width: ${width}px }` })
        const overflow = await page.evaluate(() => {
          const box = document.querySelector('.thought__text')!
          const list = document.querySelector('.messages')!
          return {
            box: box.scrollWidth - box.clientWidth,
            thread: list.scrollWidth - list.clientWidth,
          }
        })
        expect({ working, width, ...overflow }).toEqual({ working, width, box: 0, thread: 0 })
      }
    }
  } finally {
    await browser.close()
  }
})

// A reasoning longer than the box is read by scrolling it down: the bar is the app's own dim one,
// drawn in layout so it can be measured (a styled scrollbar takes its width out of the client box),
// and it never appears across the bottom — a sideways bar in the reasoning is what this box must
// never grow.
const tall = (): string => `
  <style>${CSS}</style>
  <div id="panel" class="side-panel side-panel--thread">
    <div class="messages">
      <article class="msg msg--agent"><div class="msg__gutter"></div><div class="msg__body">
        <div class="msg__head"><span class="msg__author">Tuca</span></div>
        <div class="steps is-open is-working"><div class="thought is-open is-working">
          <button type="button" class="thought__head" aria-expanded="true"><span class="thought__label">Thinking</span></button>
          <div class="thought__text">${Array.from({ length: 40 }, (_, i) => `<div>line ${i} of a reasoning that does not fit in the box</div>`).join('')}</div>
        </div></div>
      </div></article>
    </div>
  </div>`

it.skipIf(!existsSync(chromium.executablePath()))('scrolls down with the app\'s dim scrollbar, and never sideways', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 800, height: 800 })
    await page.setContent(tall())
    await page.addStyleTag({ content: '#panel { width: 420px }' })
    const box = await page.evaluate(() => {
      const el = document.querySelector('.thought__text') as HTMLElement
      const style = getComputedStyle(el)
      const before = { top: el.scrollTop, left: el.scrollLeft }
      el.scrollTop = 9_999 // as far down as it goes
      el.scrollLeft = 9_999 // and across, which it must refuse
      return {
        scrollsDown: el.scrollHeight > el.clientHeight + 1,
        kind: style.overflowY,
        overflowX: style.overflowX,
        mask: style.maskImage,
        before,
        top: el.scrollTop,
        left: el.scrollLeft,
        bottom: el.scrollHeight - el.clientHeight,
      }
    })
    expect(box.scrollsDown).toBe(true) // there is something below the box's bottom
    expect(box.before).toEqual({ top: 0, left: 0 }) // it starts on the first line
    expect(box.top).toBeGreaterThan(0) // and the wheel takes it down to the newest line
    expect(box.kind).toBe('auto')
    expect(box.left).toBe(0) // never across the bottom
    expect(box.overflowX).toBe('hidden')
    expect(box.mask).toBe('none') // the mask that painted the bar away is gone
    // The bar itself is the box's own, in the app's dim colour — the rules drawn for it, since a
    // scrollbar's paint can't be read back from `getComputedStyle` (`::-webkit-scrollbar` is not an
    // element). Chromium draws it in layout, as it draws the message list's.
    expect(CSS).toContain('.thought__text::-webkit-scrollbar {')
    expect(CSS).toMatch(/\.thought__text::-webkit-scrollbar-thumb \{[^}]*--border-strong/)
    expect(CSS).not.toMatch(/^\.thought__text \{[^}]*scrollbar-width/m)
  } finally {
    await browser.close()
  }
})
