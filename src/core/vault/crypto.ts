// The vault's cryptography, all of it node:crypto. One random vault key (VK) seals every item with
// AES-256-GCM, bound to the item by its id and version (AAD), so a sealed value moved to another
// item, or an old version put back, doesn't open. The VK itself is kept twice, wrapped:
//  - by the device key, a random secret the OS keychain keeps (safeStorage on a desktop, the
//    server's key on a server), so the vault opens on its own when Tucano starts;
//  - by the recovery code, shown once, for when the keychain is gone (a new computer, a restore).
// Comparisons of anything secret are constant-time.
import * as nodeCrypto from 'node:crypto'
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const VERSION = 1
const IV = 12
const TAG = 16
export const KEY_BYTES = 32

export const newKey = (): Buffer => randomBytes(KEY_BYTES)

// Sealed text: base64 of version | iv | tag | ciphertext.
export function seal(key: Buffer, plain: Buffer, aad: string): string {
  if (key.length !== KEY_BYTES) throw new Error('vault key must be 32 bytes')
  const iv = randomBytes(IV)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(aad, 'utf8'))
  const body = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), body]).toString('base64')
}

// Throws when the key, the AAD or the text is wrong (GCM checks its tag in constant time).
export function open(key: Buffer, sealed: string, aad: string): Buffer {
  if (key.length !== KEY_BYTES) throw new Error('vault key must be 32 bytes')
  const b = Buffer.from(sealed, 'base64')
  if (b.length < 1 + IV + TAG || b[0] !== VERSION) throw new Error('unknown vault format')
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(1, 1 + IV))
  d.setAAD(Buffer.from(aad, 'utf8'))
  d.setAuthTag(b.subarray(1 + IV, 1 + IV + TAG))
  return Buffer.concat([d.update(b.subarray(1 + IV + TAG)), d.final()])
}

// Overwrites a buffer that held a key or a value. JS strings can't be wiped: values live as
// buffers for as long as they can, and strings only for the moment a call needs them.
export const wipe = (...bufs: (Buffer | null | undefined)[]): void => {
  for (const b of bufs) b?.fill(0)
}

// Equal, in time that depends on neither content nor length (both hashed first).
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

// ---------- key derivation ----------

// The key that wraps the VK, from the device secret (already random: HKDF only separates domains).
export const deviceKek = (device: Buffer): Buffer => Buffer.from(hkdfSync('sha256', device, Buffer.alloc(0), 'tucano-vault-device-v1', KEY_BYTES))

export type Kdf = { alg: 'argon2id'; salt: string; memory: number; passes: number; parallelism: number } | { alg: 'scrypt'; salt: string; n: number; r: number; p: number }

type Argon2Sync = (alg: 'argon2id', p: { message: Buffer; nonce: Buffer; parallelism: number; tagLength: number; memory: number; passes: number }) => Buffer
const argon2Sync = (nodeCrypto as unknown as { argon2Sync?: Argon2Sync }).argon2Sync

// Argon2id where this Node has it (Electron's does); scrypt otherwise (an older Node running the server or the tests).
// Which one, and its parameters, are saved with what it wrapped.
export function newKdf(): Kdf {
  const salt = randomBytes(16).toString('base64')
  return argon2Sync ? { alg: 'argon2id', salt, memory: 65_536, passes: 3, parallelism: 4 } : { alg: 'scrypt', salt, n: 1 << 15, r: 8, p: 1 }
}

export function derive(secret: Buffer, kdf: Kdf): Buffer {
  const salt = Buffer.from(kdf.salt, 'base64')
  let stretched: Buffer
  if (kdf.alg === 'argon2id') {
    if (!argon2Sync) throw new Error('this Node has no Argon2')
    stretched = argon2Sync('argon2id', { message: secret, nonce: salt, parallelism: kdf.parallelism, tagLength: KEY_BYTES, memory: kdf.memory, passes: kdf.passes })
  } else stretched = scryptSync(secret, salt, KEY_BYTES, { N: kdf.n, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.n * kdf.r * 2 })
  const key = Buffer.from(hkdfSync('sha256', stretched, salt, 'tucano-vault-recovery-v1', KEY_BYTES))
  wipe(stretched)
  return key
}

// ---------- the recovery code ----------
// 20 random bytes (160 bits) and a 2-byte checksum, in Crockford-like Base32, in groups of 6:
// TUCANO-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX.

const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789' // no I, L, O, U: nothing to misread
const PREFIX = 'TUCANO'
const BODY = 20
const SUM = 2

function base32(b: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of b) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function unbase32(s: string): Buffer | undefined {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch)
    if (i < 0) return undefined
    value = ((value << 5) | i) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

const checksum = (body: Buffer): Buffer => createHash('sha256').update(PREFIX).update(body).digest().subarray(0, SUM)

export function newRecoveryCode(): { code: string; secret: Buffer } {
  const body = randomBytes(BODY)
  const chars = base32(Buffer.concat([body, checksum(body)]))
  const groups = chars.match(/.{1,6}/g) ?? []
  return { code: [PREFIX, ...groups].join('-'), secret: body }
}

// The code's secret, or undefined when it isn't one (typo, wrong checksum). Spaces, dashes and case
// don't matter; the letters people confuse (O/0, I/L/1) read as the digits.
export function readRecoveryCode(code: string): Buffer | undefined {
  const clean = code
    .toUpperCase()
    .replace(/^\s*TUCANO/, '')
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  const raw = unbase32(clean)
  if (!raw || raw.length < BODY + SUM) return undefined
  const body = raw.subarray(0, BODY)
  const ok = safeEqual(raw.subarray(BODY, BODY + SUM), checksum(body))
  return ok ? Buffer.from(body) : undefined
}
