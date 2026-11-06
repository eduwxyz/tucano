import { describe, expect, it } from 'vitest'
import { isAppPage, isOutsideLink } from '../src/shared/links'
import { LOCAL_LINK } from '../src/shared/path-text'
import { safeUrl } from '../src/renderer/src/links'

const BUILT = 'file:///Applications/Tucano.app/Contents/Resources/app.asar/out/renderer/index.html'
const DEV = 'http://localhost:5173'

describe('the app window only shows the app', () => {
  it('lets the built page reload, with or without a #hash', () => {
    expect(isAppPage(BUILT, BUILT)).toBe(true)
    expect(isAppPage(`${BUILT}#/c/1`, BUILT)).toBe(true)
  })

  it('never takes a local page for the app, which would hand it the bridge to the core', () => {
    expect(isAppPage('file:///Users/x/report.html', BUILT)).toBe(false)
    expect(isAppPage('file:///Applications/Tucano.app/Contents/Resources/app.asar/out/renderer/other.html', BUILT)).toBe(false)
    expect(isAppPage('file:///Users/x/report.html', DEV)).toBe(false)
    expect(isAppPage('tucano://artifact/x/a.html', BUILT)).toBe(false)
  })

  it('takes the dev server for the app while developing, and nothing else', () => {
    expect(isAppPage(`${DEV}/`, DEV)).toBe(true)
    expect(isAppPage('http://localhost:5174/', DEV)).toBe(false)
    expect(isAppPage('https://example.com/', DEV)).toBe(false)
  })

  it('says no to what is not a URL', () => {
    expect(isAppPage('/Users/x/report.html', BUILT)).toBe(false)
  })
})

describe('links handed to the system', () => {
  it('are the web and mail only', () => {
    expect(isOutsideLink('https://linear.app/x')).toBe(true)
    expect(isOutsideLink('http://localhost:3000')).toBe(true)
    expect(isOutsideLink('mailto:a@b.co')).toBe(true)
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'x-apple.systempreferences:', 'tucano://artifact/x', '/Users/x/report.html'])
      expect(isOutsideLink(url)).toBe(false)
  })
})

describe('links in markdown', () => {
  it('keep the web, mail, places in the app and files the core resolves', () => {
    for (const url of ['https://github.com', 'mailto:a@b.co', '#wiki/Clientes', '#att/a.png', `${LOCAL_LINK}%2Ftmp%2Fa.png`]) expect(safeUrl(url, 'href')).toBe(url)
  })

  it('drop a bare path, which would load a local page as the app', () => {
    expect(safeUrl('/path/to/report.html', 'href')).toBeUndefined()
    expect(safeUrl('report.html', 'href')).toBeUndefined()
    expect(safeUrl('file:///path/to/report.html', 'href')).toBeUndefined()
    expect(safeUrl('javascript:alert(1)', 'href')).toBeUndefined()
  })

  it('leave images as react-markdown does', () => {
    expect(safeUrl('a.png', 'src')).toBe('a.png')
    expect(safeUrl('javascript:alert(1)', 'src')).toBe('')
  })
})
