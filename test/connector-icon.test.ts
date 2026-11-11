import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConnectorManager, connectorIcon, MAX_ICON_CHARS, MAX_ICON_URL } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { plainCipher, Secrets } from '../src/core/secrets'

let db: Db
let connectors: ConnectorManager
let file: string

// A square of one pixel: what the screen hands over, only smaller.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
// Nothing is listening on port 9: the connector goes to error in the background, which is not what these read.
const NOWHERE = 'http://127.0.0.1:9/mcp'

beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'tucano-icon-')), 'test.db')
  db = new Db(file)
  connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: () => {}, openUrl: () => {}, oauthCallbackUrl: () => 'http://127.0.0.1:1/oauth/callback' })
})

afterEach(async () => {
  await connectors.closeAll()
  db.close()
})

const addLocal = (icon?: string): Promise<string> => connectors.add({ name: 'Google Services', kind: 'remote', url: NOWHERE, auth: 'none', icon })

describe('the image a connector wears', () => {
  it('comes with the connector and is kept', async () => {
    const id = await addLocal(PNG)
    expect(connectors.get(id)!.icon).toBe(PNG)
    expect(db.connectors().find((c) => c.id === id)!.icon).toBe(PNG)
  })

  it('is set, replaced and taken off without touching the connection', async () => {
    const id = await addLocal()
    expect(connectors.get(id)!.icon).toBeUndefined()
    connectors.setIcon(id, PNG)
    expect(connectors.get(id)!.icon).toBe(PNG)
    expect(connectors.get(id)!.url).toBe(NOWHERE)
    const other = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    connectors.setIcon(id, other)
    expect(connectors.get(id)!.icon).toBe(other)
    connectors.setIcon(id, undefined)
    expect(connectors.get(id)!.icon).toBeUndefined()
  })

  it('survives the app closing and opening', () => {
    db.saveConnector({ id: 'kept', name: 'Google Services', kind: 'remote', url: NOWHERE, auth: 'none', icon: PNG })
    db.close()
    db = new Db(file)
    expect(db.connector('kept')!.icon).toBe(PNG)
  })

  it('refuses what is not an image, and leaves the row as it was', async () => {
    const id = await addLocal(PNG)
    expect(() => connectors.setIcon(id, 'data:text/html;base64,PHNjcmlwdD4=')).toThrow(/PNG/)
    expect(() => connectors.setIcon(id, 'http://example.com/logo.png')).toThrow(/https/)
    expect(() => connectors.setIcon(id, 'nonsense')).toThrow(/imagem|image/)
    expect(() => connectors.setIcon(id, `${PNG}${'A'.repeat(MAX_ICON_CHARS)}`)).toThrow(/grande demais|too big/)
    expect(connectors.get(id)!.icon).toBe(PNG)
  })

  it('refuses a bad one at the form too, before the connector exists', async () => {
    await expect(addLocal('data:image/svg+xml;base64,PHN2Zz4=')).rejects.toThrow(/PNG|JPEG/)
    expect(db.connectors().some((c) => c.name === 'Google Services')).toBe(false)
  })

  it('keeps what the screen hands over and nothing else', () => {
    expect(connectorIcon(` ${PNG} `)).toBe(PNG)
    expect(connectorIcon('')).toBeUndefined()
    expect(connectorIcon(undefined)).toBeUndefined()
    expect(connectorIcon(null)).toBeUndefined()
    expect(connectorIcon('https://example.com/a.png')).toBe('https://example.com/a.png')
    for (const bad of ['http://example.com/a.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png,notbase64', 'file:///C:/logo.png', 'javascript:alert(1)'])
      expect(() => connectorIcon(bad)).toThrow()
  })

  it('takes an https address as it is, and refuses every other way of naming an image', () => {
    const link = 'https://cdn.example.com/logos/google.png?v=2'
    expect(connectorIcon(` ${link} `)).toBe(link)
    expect(() => connectorIcon('//cdn.example.com/a.png')).toThrow(/https/)
    expect(() => connectorIcon('http://cdn.example.com/a.png')).toThrow(/https/)
    expect(() => connectorIcon('javascript:alert(1)')).toThrow()
    expect(() => connectorIcon(`https://cdn.example.com/${'a'.repeat(MAX_ICON_URL)}`)).toThrow(/longo demais|too long/)
  })

  it('keeps an address through the connector and a reopen, and swaps it for a file', async () => {
    const link = 'https://cdn.example.com/logos/google.png'
    const id = await addLocal(link)
    expect(db.connector(id)!.icon).toBe(link)
    connectors.setIcon(id, PNG)
    expect(connectors.get(id)!.icon).toBe(PNG)
    connectors.setIcon(id, link)
    // The background call to nowhere settles first, so nothing touches the file after it closes.
    for (let i = 0; i < 100 && connectors.get(id)!.status !== 'error'; i++) await new Promise((r) => setTimeout(r, 20))
    await connectors.closeAll()
    db.close()
    db = new Db(file)
    expect(db.connector(id)!.icon).toBe(link)
  })
})
