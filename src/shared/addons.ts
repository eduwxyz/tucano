// The extensions an agent's browser can carry (core/chrome-addons.ts), each with its own switch in
// Settings › Agents. Their ids are the Chrome Web Store's own, which is what the store's update endpoint
// asks for, and the one place the three are listed: the core asks for them and the settings page draws a
// row for each, so a name cannot drift from what is installed.
import type { AddOn, BrowserAddOns } from './types'

export interface AddOnExtension {
  key: AddOn // its switch in the settings
  id: string // its id in the Web Store
  name: string
}

// An ad blocker first: it is the one that changes the most pages, and the one that removes most of what a
// consent dialog was covering. The two notice removers answer different designs: one clicks the banner
// away, the other answers the dialog's own questions (the "legitimate interest" lists GDPR pages put in
// front of an article).
export const ADD_ONS: readonly AddOnExtension[] = [
  { key: 'ads', id: 'ddkjiahejlhfcafbddmgiahcphecmpfh', name: 'uBlock Origin Lite' },
  { key: 'cookies', id: 'edibdbjcniadpccecjdfdjjppcpchdlm', name: "I still don't care about cookies" },
  { key: 'consent', id: 'mdjildafknihdffpkfmmpnpoiajfjnjd', name: 'Consent-O-Matic' }
]

// Until this release the three arrived on one switch, so `true` may still be saved from that build: it
// meant all of them.
export function addOnsOf(value: BrowserAddOns | boolean | null | undefined): BrowserAddOns {
  if (value === true) return { ads: true, cookies: true, consent: true }
  return value && typeof value === 'object' ? value : {}
}

export const addOnOn = (value: BrowserAddOns | boolean | null | undefined, key: AddOn): boolean => !!addOnsOf(value)[key]
