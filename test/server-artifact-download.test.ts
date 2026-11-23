// A file an agent sent, on a server (16/11 and 19/11, a person's report): the card only had Open,
// and a .docx opened in a browser shows nothing, so there was no way to get the file. The server's
// /artifact route now sends it as a download (?download) under its real name, still only from that
// artifact's own folder and only to someone who may see it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveArtifact } from '../src/server/artifact-http'
import { ARTIFACT_CSP, attachment } from '../src/server/guard'
import { Grants } from '../src/server/people'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const DOCX = 'Comparativo_Email_Reluzir_BRAXT.docx'
const ACCENTED = 'fluxo do atendimento – brenda (png alta).png'

let dataDir: string
let server: Server
let base: string
let allowed: Set<string>
let served = true // whether the route said the address was its own

// The raw path goes out as written: fetch would tidy `..` away before the server ever saw it.
const get = (path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> =>
  new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { path }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => parts.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }))
    })
    req.on('error', reject)
    req.end()
  })

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'tucano-artifact-'))
  mkdirSync(join(dataDir, 'artifacts', ID, 'sub'), { recursive: true })
  mkdirSync(join(dataDir, 'artifacts', OTHER), { recursive: true })
  writeFileSync(join(dataDir, 'artifacts', ID, DOCX), 'PK docx bytes')
  writeFileSync(join(dataDir, 'artifacts', ID, ACCENTED), 'png bytes')
  writeFileSync(join(dataDir, 'artifacts', OTHER, 'secret.txt'), 'not yours')
  writeFileSync(join(dataDir, 'server-token'), 'the token')
  allowed = new Set([ID])
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x') // as src/server/index.ts reads it
    served = serveArtifact(res, url, { dataDir, may: async (id) => allowed.has(id), type: (p) => (p.endsWith('.png') ? 'image/png' : 'application/octet-stream') })
    if (!served) res.writeHead(418).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise((r) => server.close(r))
  rmSync(dataDir, { recursive: true, force: true })
})

describe('an artifact, downloaded from a server', () => {
  it('comes as an attachment under its real name, with its bytes', async () => {
    const r = await get(`/artifact/${ID}/${encodeURIComponent(DOCX)}?download=1`)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('application/octet-stream')
    expect(r.headers['content-disposition']).toBe(`attachment; filename="${DOCX}"; filename*=UTF-8''${DOCX}`)
    expect(r.headers['content-length']).toBe(String('PK docx bytes'.length))
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['content-security-policy']).toBe('sandbox')
    expect(r.body.toString()).toBe('PK docx bytes')
  })

  it('keeps accents, spaces and parentheses in the name it saves under', async () => {
    const r = await get(`/artifact/${ID}/${encodeURIComponent(ACCENTED)}?download`)
    expect(r.status).toBe(200)
    const cd = String(r.headers['content-disposition'])
    expect(cd).toMatch(/^attachment; filename="fluxo do atendimento _ brenda \(png alta\)\.png"; filename\*=UTF-8''/)
    const encoded = cd.split("filename*=UTF-8''")[1]!
    expect(encoded).not.toMatch(/[ ()'*]/) // RFC 5987: those are escaped too
    expect(decodeURIComponent(encoded)).toBe(ACCENTED)
  })

  it('without ?download is shown as before: its own type, sandboxed, no attachment', async () => {
    const r = await get(`/artifact/${ID}/${encodeURIComponent(ACCENTED)}`)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('image/png')
    expect(r.headers['content-security-policy']).toBe(ARTIFACT_CSP)
    expect(r.headers['content-disposition']).toBeUndefined()
  })

  it('is not found for someone who may not see it, download or not', async () => {
    allowed.delete(ID)
    try {
      expect((await get(`/artifact/${ID}/${encodeURIComponent(DOCX)}?download=1`)).status).toBe(404)
      expect((await get(`/artifact/${ID}/${encodeURIComponent(DOCX)}`)).status).toBe(404)
    } finally {
      allowed.add(ID)
    }
  })

  it('never leaves the artifact’s own folder', async () => {
    allowed.add(OTHER)
    for (const name of [`..%2F${OTHER}%2Fsecret.txt`, '..%2F..%2Fserver-token', '%2E%2E%2F%2E%2E%2Fserver-token', '..%5C..%5Cserver-token', 'sub', 'missing.docx', '%E0%A4%A'])
      expect((await get(`/artifact/${ID}/${name}?download=1`)).status, name).toBe(404)
    allowed.delete(OTHER)
    // A bare `..` or `.` is folded away by the address itself; an id that isn't one, or a deeper
    // path: not this route's (the page's own files, which check the same way, come next).
    for (const path of [`/artifact/${ID}/..?download=1`, `/artifact/${ID}/%2E%2E?download=1`, `/artifact/${ID}/.?download=1`, '/artifact/../server-token?download=1', `/artifact/${ID}/sub/x?download=1`, '/artifact/not-an-id/x?download=1']) {
      expect((await get(path)).status, path).toBe(418)
      expect(served).toBe(false)
    }
  })

  it('sits behind sign-in, and no one signed in may see anything', async () => {
    const asked: string[] = []
    const grants = new Grants(async (person, what) => (asked.push(`${person}:${'artifact' in what ? what.artifact : ''}`), true))
    expect(await grants.may(undefined, { artifact: ID })).toBe(false)
    expect(asked).toEqual([])
    // The route sits behind sign-in: it's reached only from signedIn, which only authed calls.
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'index.ts'), 'utf8')
    const signedIn = src.slice(src.indexOf('function signedIn('))
    expect(signedIn).toMatch(/serveArtifact\(res, url, \{ dataDir, may: \(id\) => grants\.may\(who\.person \?\? ownerId, \{ artifact: id \}\)/)
    expect(src.slice(0, src.indexOf('function signedIn('))).not.toMatch(/serveArtifact\(/)
  })
})

describe('the attachment header', () => {
  it('lets nothing in a name end the header or add another', () => {
    const h = attachment('a"b\\c\r\nSet-Cookie: x=1.txt')
    expect(h).not.toMatch(/[\r\n]/)
    expect(h.split('filename="')[1]!.split('"')[0]).toBe('a_b_c__Set-Cookie: x=1.txt')
    expect(decodeURIComponent(h.split("filename*=UTF-8''")[1]!)).toBe('a"b\\c\r\nSet-Cookie: x=1.txt')
  })
})
