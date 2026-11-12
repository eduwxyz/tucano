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
