import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// The server's stand-in for the system keychain: AES-256-GCM with a key kept in
// a file only its user reads. Sealed text is iv | tag | ciphertext, in base64.
export function vault(key: Buffer): { seal: (text: string) => string; open: (sealed: string) => string } {
  if (key.length !== 32) throw new Error('the server key must be 32 bytes')
  return {
    seal(text) {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([c.update(text, 'utf8'), c.final()])
      return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')
    },
    open(sealed) {
      const b = Buffer.from(sealed, 'base64')
      const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
      d.setAuthTag(b.subarray(12, 28))
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')
    }
  }
}
