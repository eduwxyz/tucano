import { runInNewContext } from 'node:vm'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isPrivate, serviceAccess } from '../src/server/forward'
import { webBridge, webPage } from '../src/server/web'

// Run the actual browser bridge without connecting it or opening any listeners.
function browserPreview(bindHost: string, optIn: string | undefined, browserUrl: string): boolean {
  const window = {} as { tucano: { servicePreviews: boolean } }
  runInNewContext(webBridge(serviceAccess(bindHost, optIn).previewHost), { window, location: new URL(browserUrl) })
  return window.tucano.servicePreviews
}

describe('explicit opt-in for unauthenticated agent service forwarding', () => {
  const privateHosts = ['10.0.0.2', '172.16.0.1', '172.31.255.254', '192.168.3.1', '100.64.0.1', '100.127.255.254']

  it('leaves forwarding and private frame access off by default on every private range', () => {
    for (const host of privateHosts) {
      for (const optIn of [undefined, '', '0', 'true', 'yes', '01', ' 1', '1 ']) {
        expect(serviceAccess(host, optIn)).toEqual({ enabled: false, previewHost: null, frameSrc: "frame-src 'self' tucano:" })
        expect(browserPreview(host, optIn, `http://${host}:7337`)).toBe(false)
      }
    }
  })

  it('requires exactly 1 and a specific private IPv4 address for the deliberate path', () => {
    for (const host of privateHosts) {
      expect(serviceAccess(host, '1')).toEqual({ enabled: true, previewHost: host, frameSrc: `frame-src 'self' tucano: http://${host}:*` })
      expect(browserPreview(host, '1', `http://${host}:7337`)).toBe(true)
    }
  })

  it('replaces native loopback frame access without changing other policies or the native page', () => {
    const nativePage = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
    expect(nativePage).toContain('frame-src tucano: http://127.0.0.1:*')
    for (const optIn of [undefined, '1']) {
      const policy = serviceAccess('100.64.0.1', optIn)
      const page = webPage(nativePage, policy.frameSrc)
      expect(page).toContain(`${policy.frameSrc}"`)
      expect(page).not.toContain('http://127.0.0.1:*')
      expect(page).toContain("connect-src 'self' tucano:")
      expect(page).toContain('<script src="./tucano-web.js"></script>')
    }
    expect(nativePage).toContain('frame-src tucano: http://127.0.0.1:*')
  })

  it('never enables forwarding for loopback, wildcard, public, IPv6 or hostname binds', () => {
    for (const host of ['127.0.0.1', 'localhost', '0.0.0.0', '::', '::1', 'fd00::1', '203.0.113.2', '172.32.0.1', '100.63.0.1', '100.128.0.1', '10.example.com', '10.0.0.999', '192.168.0.1.example.com', '100.64.0.1:7337']) {
      expect(isPrivate(host)).toBe(false)
      expect(serviceAccess(host, '1')).toEqual({ enabled: false, previewHost: null, frameSrc: "frame-src 'self' tucano:" })
    }
  })

  it('does not mistake a local browser address or SSH control tunnel for forwarded service ports', () => {
    for (const bindHost of ['127.0.0.1', '0.0.0.0', '192.168.3.1', '100.64.0.1']) {
      for (const optIn of [undefined, '1']) {
        for (const browserUrl of ['http://127.0.0.1:7337', 'http://localhost:7337', 'http://[::1]:7337']) {
          expect(browserPreview(bindHost, optIn, browserUrl)).toBe(false)
        }
      }
    }
  })

  it('keeps HTTPS proxy views, aliases and other private hosts from opening plaintext preview ports', () => {
    for (const browserUrl of ['https://100.64.0.1:7337', 'https://server.example.com', 'http://server.example.com:7337', 'http://server.tailnet.ts.net:7337', 'http://100.64.0.2:7337']) {
      expect(browserPreview('100.64.0.1', '1', browserUrl)).toBe(false)
    }
  })
})
