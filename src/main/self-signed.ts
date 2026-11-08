// A certificate of this computer's own, for the phone link at home (home-link.ts). No authority
// vouches for it: the QR code carries its fingerprint, and the phone talks to this certificate and
// no other (the iPhone app's Pin), so someone else on the same Wi-Fi can't stand in for the Mac.
//
// Node can make the key but not the certificate, so this writes the little X.509 it needs by hand:
// ECDSA P-256 with SHA-256, the computer's names in subjectAltName, ten years.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto'

// DER: a tag, its length, its content.
function tlv(tag: number, content: Buffer): Buffer {
  const n = content.length
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff])
  return Buffer.concat([Buffer.from([tag]), len, content])
}
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts))
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts))
const explicit = (n: number, inner: Buffer): Buffer => tlv(0xa0 + n, inner)

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number)
  const bytes = [a! * 40 + b!]
  for (const v of rest) {
    const chunk = [v & 0x7f]
    for (let x = v >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80)
    bytes.push(...chunk)
  }
  return tlv(0x06, Buffer.from(bytes))
}

// A positive INTEGER from random bytes (a leading 0 when the top bit is set).
function serial(): Buffer {
  const b = randomBytes(16)
  b[0] = b[0]! & 0x7f || 0x01
  return tlv(0x02, b)
}

// UTCTime (YYMMDDHHMMSSZ) up to 2049, as X.509 asks; GeneralizedTime after.
function time(d: Date): Buffer {
  const p = (n: number): string => String(n).padStart(2, '0')
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  const y = d.getUTCFullYear()
  return y < 2050 ? tlv(0x17, Buffer.from(`${String(y % 100).padStart(2, '0')}${rest}`, 'ascii')) : tlv(0x18, Buffer.from(`${y}${rest}`, 'ascii'))
}

const name = (cn: string): Buffer => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn, 'utf8')))))
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'))

// subjectAltName: DNS names, and IP addresses (v4) as their four bytes.
function altNames(names: string[]): Buffer {
  const entries = names.map((n) => (/^\d{1,3}(\.\d{1,3}){3}$/.test(n) ? tlv(0x87, Buffer.from(n.split('.').map(Number))) : tlv(0x82, Buffer.from(n, 'ascii'))))
  return seq(oid('2.5.29.17'), tlv(0x04, seq(...entries)))
}

export interface SelfSigned {
  key: string // PEM, PKCS#8
  cert: string // PEM
  fingerprint: string // sha256 of the certificate's DER, base64url: what the QR code's `fp` holds
}

// The fingerprint the phone checks: sha256 of the certificate (DER), base64url, no padding.
export const fingerprintOf = (certPem: string): string => createHash('sha256').update(new X509Certificate(certPem).raw).digest('base64url')

export function makeCertificate(commonName: string, names: string[], now = new Date(), years = 10): SelfSigned {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const until = new Date(now)
  until.setUTCFullYear(until.getUTCFullYear() + years)
  const from = new Date(now.getTime() - 24 * 3600_000) // a day back: a phone whose clock runs late still takes it
  const tbs = seq(
    explicit(0, tlv(0x02, Buffer.from([2]))), // v3
    serial(),
    ECDSA_SHA256,
    name(commonName),
    seq(time(from), time(until)),
    name(commonName),
    spki,
    explicit(3, seq(altNames(names.length ? names : [commonName])))
  )
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' })
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])))
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, cert, fingerprint: createHash('sha256').update(der).digest('base64url') }
}

// A saved pair still goes together (the key signs for the certificate's public key).
export function matches(pair: { key: string; cert: string }): boolean {
  try {
    const pub = new X509Certificate(pair.cert).publicKey.export({ type: 'spki', format: 'der' })
    return createPublicKey(createPrivateKey(pair.key)).export({ type: 'spki', format: 'der' }).equals(pub)
  } catch {
    return false
  }
}
