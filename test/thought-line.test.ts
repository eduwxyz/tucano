// The reasoning block under a reply's steps: its line has to be the chain's line, and the block itself
// may scroll down but never sideways. Two separate slips, both measured in the real stylesheet:
//  - `.steps__list` is indented 3px and carries the 2px rail, while `.thought` sat at 0, so the line
//    broke by 3px exactly where the steps hand over to the reasoning.
//  - the reasoning box set only `overflow-y`, and a box with `overflow-y: auto` and
//    `overflow-x: visible` computes to `overflow-x: auto`: a path in the reasoning, with nowhere to
//    wrap, raised a sideways scrollbar on the block.
// Layout needs a browser: linkedom has no getBoundingClientRect worth trusting and no scrollWidth.
import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

const CSS = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
// A line of reasoning with nowhere to break: the shape a thought takes when it reads a path.
const LONG = 'C:\\git-ext\\tucano\\src\\renderer\\src\\components\\Conversation.tsx:11799:thinking'

// The chain as this renderer builds it: the toggle, the list with its rail, and the thought after
// both, inside the same `.steps`.
const markup = (working: boolean): string => `
  <style>${CSS}</style>
  <div id="panel" class="side-panel side-panel--thread">
    <div class="messages">
      <article class="msg msg--agent">
        <div class="msg__gutter"></div>
        <div class="msg__body">
          <div class="steps is-open${working ? ' is-working' : ''}">
            <button type="button" class="steps__toggle">
              <span class="steps__summary">3 steps</span>
            </button>
            <ol class="steps__list">
              <li class="step step--done"><span class="step__label">Read the file</span></li>
              <li class="step step--done"><span class="step__label">Ran the tests</span></li>
            </ol>
            <div class="thought is-open${working ? ' is-working' : ''}" aria-label="What the agent is thinking">
              <button type="button" class="thought__head" aria-expanded="true">
                <span class="thought__label">${working ? 'Thinking' : 'Thought'}</span>
              </button>
              <div class="thought__text">Checking ${LONG} before the next step, because the word has to be whole and the line has to end.</div>
            </div>
          </div>
          <div class="md"><p>Here is the answer.</p></div>
        </div>
      </article>
    </div>
  </div>`

it.skipIf(!existsSync(chromium.executablePath()))('draws the reasoning line where the steps line is, and never sideways', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    // A thread is the narrowest column the app has (`.side-panel--thread` floors at 360px), so both
    // the alignment and the sideways scroll are measured there, at the panel's default, and wide.
    for (const width of [360, 420, 700]) {
      for (const working of [true, false]) {
        await page.setViewportSize({ width: width + 240, height: 900 })
        await page.setContent(markup(working))
        await page.addStyleTag({ content: `#panel { width: ${width}px }` })
        const m = await page.evaluate(() => {
          const thought = document.querySelector('.thought') as HTMLElement
          const list = document.querySelector('.steps__list') as HTMLElement
          const text = document.querySelector('.thought__text') as HTMLElement
          const thread = document.querySelector('.messages') as HTMLElement
          return {
            thoughtLine: Math.round(thought.getBoundingClientRect().left * 100) / 100,
            stepsLine: Math.round(list.getBoundingClientRect().left * 100) / 100,
            blockOverflow: text.scrollWidth - text.clientWidth,
            threadOverflow: thread.scrollWidth - thread.clientWidth,
          }
        })
        // One line, not two a hair apart.
        expect({ width, working, at: m.thoughtLine }).toEqual({ width, working, at: m.stepsLine })
        // Nothing to scroll sideways, in the block or in the thread around it.
        expect({ width, working, block: m.blockOverflow, thread: m.threadOverflow }).toEqual({
          width,
          working,
          block: 0,
          thread: 0,
        })
      }
    }
  } finally {
    await browser.close()
  }
})
