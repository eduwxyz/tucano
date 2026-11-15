import { createServer } from 'vite'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

it('preserves a retained passage across prefix eviction without changing folding or following', async () => {
  const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0, hmr: false }, appType: 'custom', oxc: { jsx: { runtime: 'automatic' } }, optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-markdown', 'remark-gfm', 'open-bot-avatar', 'open-bot-avatar/dom', 'qrcode-generator'] }, resolve: { dedupe: ['react', 'react-dom'] } })
  server.middlewares.use((req, res, next) => {
    if (req.url !== '/') return next()
    res.setHeader('Content-Type', 'text/html')
    res.end('<html><body><div id="root"></div><script type="module" src="/test/fixtures/thought-boundary.tsx"></script></body></html>')
  })
  await server.listen()
  const address = server.httpServer!.address() as { port: number }
  const browser = await chromium.launch({ headless: true, ...(process.env.TUCANO_BROWSER_CHANNEL ? { channel: process.env.TUCANO_BROWSER_CHANNEL } : {}) })
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 880 } })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await page.waitForFunction(() => typeof (window as any).emitThought === 'function')
    await page.evaluate(() => (window as any).emitThought(Array.from({ length: 1000 }, (_, i) => `${String(i).padStart(4, '0')} retained line.\n`).join('')))
    const box = page.locator('.thought__text')
    await expect.poll(() => box.textContent()).toContain('0999 retained line.')
    await page.evaluate(() => {
      const box = document.querySelector('.thought__text')!
      const text = box.firstChild!
      const offset = text.textContent!.indexOf('0500 retained line.')
      const range = document.createRange()
      range.setStart(text, offset)
      range.setEnd(text, offset + 1)
      box.scrollTop += range.getBoundingClientRect().top - box.getBoundingClientRect().top - 40
      box.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    const top = () => page.evaluate(() => {
      const text = document.querySelector('.thought__text')!.firstChild!
      const offset = text.textContent!.indexOf('0500 retained line.')
      const range = document.createRange()
      range.setStart(text, offset)
      range.setEnd(text, offset + 1)
      return range.getBoundingClientRect().top
    })
    const before = await top()
    await page.evaluate(() => (window as any).emitThought('x'.repeat(1000)))
    await expect.poll(() => box.textContent()).toContain('x'.repeat(1000))
    await expect.poll(async () => Math.abs(await top() - before)).toBeLessThan(1)
    await page.evaluate(() => (window as any).emitThought('y'.repeat(1000)))
    await expect.poll(() => box.textContent()).toContain('y'.repeat(1000))
    await expect.poll(async () => Math.abs(await top() - before)).toBeLessThan(1)
    expect(await box.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0)
    await page.evaluate(() => {
      const el = document.querySelector('.thought__text')!
      el.scrollTop = el.scrollHeight
      el.dispatchEvent(new Event('scroll', { bubbles: true }))
      ;(window as any).emitThought('\nThe stream continues.')
    })
    await expect.poll(() => box.textContent()).toContain('The stream continues.')
    await expect.poll(() => box.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2)
    await page.locator('.thought__head').click()
    await expect.poll(() => box.count()).toBe(0)
    await page.evaluate(() => (window as any).emitThought(' Still folded.'))
    await expect.poll(() => box.count()).toBe(0)
    await page.locator('.thought__head').click()
    await expect.poll(() => box.count()).toBe(1)
    await page.evaluate(() => (window as any).setWorking(false))
    expect(await page.locator('.thought__head').getAttribute('aria-expanded')).toBe('true')
    await page.evaluate(() => (window as any).setThinking(false))
    await expect.poll(() => page.locator('.thought').count()).toBe(0)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
})
