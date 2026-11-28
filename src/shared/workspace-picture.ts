// The picture a workspace wears in Manage workspaces. It is kept in that workspace's own entry in
// workspaces.json, as an inline image the way a connector's icon is kept in the database: a backup
// of the profile carries it, and no other workspace can read it by accident. A remote address is
// kept as an address, not downloaded, so the same picture shows on every computer that sees it.
import { L } from './lang'
import { blockedAddress } from './net'

// The same picture shapes a connector's icon accepts, with the same cap after shrinking (the window
// shrinks a picked bitmap to 96 px before it gets here; the cap guards anything handed to the API).
const IMAGE = /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/
export const PICTURE_MAX_CHARS = 32_000
const ADDRESS_MAX_CHARS = 2_000

// An address may be https only, may not carry a login, and may not point straight into the machine or
// its LAN. The core applies the same inside-network rule before it fetches a link; the browser that
// draws an <img> gets no such second lookup here, so an IP literal is refused up front.
export function isWorkspacePicture(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  if (IMAGE.test(value)) return value.length <= PICTURE_MAX_CHARS
  if (value.length > ADDRESS_MAX_CHARS || !value.startsWith('https://')) return false
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password) return false
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return !blockedAddress(host)
  return true
}

// Empty is the default picture, not a failure: every workspace starts with the neutral thumbnail.
export function validateWorkspacePicture(value: string): void {
  const clean = value.trim()
  if (clean && !isWorkspacePicture(clean)) throw new Error(L('Isso não é uma imagem (PNG, JPEG, WebP, GIF ou SVG) nem um endereço https seguro.', 'That is not an image (PNG, JPEG, WebP, GIF or SVG) or a safe https address.'))
}
