import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

it.skipIf(!existsSync(chromium.executablePath()))('shares the routine entrance animation with dialogs and respects reduced motion', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.setContent(`<style>${readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')}</style><div class="modal__card">Dialog</div><div class="form-modal">Form</div>`)
    const animations = () => page.locator('.modal__card, .form-modal').evaluateAll((els) => els.map((el) => {
      const style = getComputedStyle(el)
      return { name: style.animationName, seconds: parseFloat(style.animationDuration) }
    }))
    expect(await animations()).toEqual([{ name: 'cal-pop', seconds: 0.18 }, { name: 'cal-pop', seconds: 0.18 }])
    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const animation of await animations()) expect(animation.seconds).toBeLessThanOrEqual(0.001)
  } finally { await browser.close() }
})

it.skipIf(!existsSync(chromium.executablePath()))('keeps danger buttons colored on hover and visible on keyboard focus', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<style>${readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')}</style><button>Before</button><button class="btn btn--danger">Delete workspace</button>`)
    const button = page.getByRole('button', { name: 'Delete workspace' })
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
      await button.hover()
      const colors = await button.evaluate((el) => {
        const style = getComputedStyle(el)
        const probe = document.createElement('span')
        probe.style.background = 'var(--hover)'
        document.body.append(probe)
        const genericHover = getComputedStyle(probe).backgroundColor
        probe.remove()
        return { background: style.backgroundColor, genericHover, color: style.color }
      })
      expect(colors.background).not.toBe(colors.genericHover)
      expect(colors.background).not.toBe('rgba(0, 0, 0, 0)')
      expect(colors.color).toBe('rgb(255, 255, 255)')
      await page.getByRole('button', { name: 'Before', exact: true }).focus()
      await page.keyboard.press('Tab')
      expect(await button.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid')
    }
  } finally { await browser.close() }
})

// Layout needs a browser: DOM-only tests cannot detect a name squeezed out by flex.
it.skipIf(!existsSync(chromium.executablePath()))('keeps the agent name visible when the sidebar role is long', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <style>${readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')}</style>
      <aside style="width: 220px">
        <button class="nav-item">
          <span style="width:18px;flex-shrink:0">A</span>
          <span class="nav-item__label">Mariana</span>
          <span class="nav-item__meta nav-item__role"></span>
          <span class="dot dot--warn"></span>
        </button>
      </aside>`)
    for (const role of ['Research and development of complex projects '.repeat(20), 'Research'.repeat(100)]) {
      await page.locator('.nav-item__role').evaluate((el, text) => { el.textContent = text }, role)
      const layout = await page.locator('.nav-item').evaluate((item) => {
        const name = item.querySelector<HTMLElement>('.nav-item__label')!
        const role = item.querySelector<HTMLElement>('.nav-item__role')!
        return {
          nameVisible: name.clientWidth >= name.scrollWidth && name.clientWidth > 0,
          roleTruncated: role.scrollWidth > role.clientWidth,
          ellipsis: getComputedStyle(role).textOverflow,
          fits: item.scrollWidth <= item.clientWidth,
          singleLine: role.getBoundingClientRect().top < name.getBoundingClientRect().bottom
        }
      })
      expect(layout).toEqual({ nameVisible: true, roleTruncated: true, ellipsis: 'ellipsis', fits: true, singleLine: true })
    }
  } finally {
    await browser.close()
  }
})

it.skipIf(!existsSync(chromium.executablePath()))('lines up system lines with the message column on a wide window', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 600 } })
    await page.setContent(`
      <style>${readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')}</style>
      <div class="messages">
        <article class="msg"><div class="msg__gutter"></div><div class="msg__body">Hello</div></article>
        <div class="system-line"><span>Used 82% of the month's limit</span></div>
      </div>`)
    const edges = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
      return { message: box('.msg'), notice: box('.system-line') }
    })
    expect(edges.notice.left).toBe(edges.message.left)
    expect(edges.notice.width).toBe(edges.message.width)
  } finally { await browser.close() }
})
