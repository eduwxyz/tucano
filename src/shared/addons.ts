// The extensions an agent's browser can carry (core/chrome-addons.ts), each with its own switch in
// Settings › Agents. Their ids are the Chrome Web Store's own, which is what the store's update endpoint
// asks for, and the one place the five are listed: the core asks for them and the settings page draws a
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
// front of an article). The two after them answer what is left over: an overlay that closes in your face but stays in
// the page's way (a sticky bar, a drawer), and a page restyled down to what is readable (Unclutter, a
// reader mode: it is the one that changes how a page looks, so it is off unless someone asks for it).
export const ADD_ONS: readonly AddOnExtension[] = [
  { key: 'ads', id: 'ddkjiahejlhfcafbddmgiahcphecmpfh', name: 'uBlock Origin Lite' },
  { key: 'cookies', id: 'edibdbjcniadpccecjdfdjjppcpchdlm', name: "I still don't care about cookies" },
  { key: 'consent', id: 'mdjildafknihdffpkfmmpnpoiajfjnjd', name: 'Consent-O-Matic' },
  { key: 'popups', id: 'ifnkdbpmgkdbfklnbfidaackdenlmhgh', name: 'PopUpOFF' },
  { key: 'clutter', id: 'ibckhpijbdmdobhhhodkceffdngnglpk', name: 'Unclutter' }
]

// What each extension ships set to, and what the app changes it to (core/chrome-addons.ts writes it into
// the unpacked folder, so the browser starts with these settings every time rather than after a click in
// its own popup). Two rules, both learned by measuring the pages an agent actually lands on (2026-11-22):
//
//   - `from` must appear exactly once in that file. A store update that moves it fails the row with the
//     line it could not find, rather than shipping an extension that quietly does its vendor's default.
//   - every edit is about what the agent sees: no request to a third party (a reader mode that reports its
//     own use to PostHog and its errors to Sentry), no tab opened by itself (a welcome page, a tutorial),
//     and the useful mode already on.
export interface TuneEdit {
  file: string // inside the unpacked extension, from its root
  from: string // exactly one of these
  to: string
  why: string // what it buys the agent, for the row's own line
}

// A revision per extension: a folder unpacked by an older build is set up again on the next start, without
// being downloaded a second time. Bump it when an edit below changes.
export const TUNE_REVISION = 1

export const TUNE: Partial<Record<AddOn, readonly TuneEdit[]>> = {
  // Its store build filters in "Basic" mode: requests are blocked and the hole the ad left stays in the
  // layout (measured 2026-11-22: an 803x250 empty box on wetter.de, a quarter of the screen). "Complete"
  // adds its cosmetic filters, which is what takes the hole away, and its scriptlets, which is what gets a
  // page to draw itself when the network blocked something it was waiting on.
  ads: [{ file: 'js/mode-manager.js', from: '    complete: [],', to: "    complete: [ 'all-urls' ],", why: 'Complete filtering from the first page' }],
  // Off until armed by hand, and by hand it is one site at a time, which is no use to an agent that meets
  // a new site every minute. "easyModeActive" is its moderate mode: clean what covers the page, keep what
  // the page needs. It also opens its own tutorial tab on install, which the agent would find in its browser.
  popups: [
    { file: 'background/background.js', from: '\t\t\t\tcurAutoMode: "whitelist",', to: '\t\t\t\tcurAutoMode: "easyModeActive",', why: 'cleans every site, not a list of them' },
    { file: 'background/background.js', from: '\t\tawait setStorageData({ curAutoMode: "whitelist" });', to: '\t\tawait setStorageData({ curAutoMode: "easyModeActive" });', why: 'the same mode, written where its popup reads it' },
    { file: 'background/background.js', from: '\t\tcurAutoMode = "whitelist";', to: '\t\tcurAutoMode = "easyModeActive";', why: 'and the value the install path then uses' },
    { file: 'background/background.js', from: '\t\t\tchrome.tabs.create({ url: "https://popupoff.org/tutorial?source=chrome" })', to: '\t\t\tvoid 0', why: 'no tutorial tab in the agent\u2019s browser' }
  ],
  // A reader mode that reports its errors to Sentry and its use to PostHog, and opens a welcome page on
  // install. In an agent's browser none of that is anybody's business but ours: both reports are switched
  // off in the build that lands, rather than left to a consent screen nobody will answer.
  clutter: [
    { file: 'background/sentry.js', from: '        enabled: !isDev,', to: '        enabled: false,', why: 'no error reports leave the computer' },
    { file: 'background/metrics.js', from: 'async function sendEvent(name, data, isDev) {', to: 'async function sendEvent(name, data, isDev) {\n    return void 0;', why: 'no usage reports leave the computer' },
    { file: 'background/install.js', from: '        url: "https://unclutter.it/welcome",', to: '        url: "about:blank",', why: 'no welcome tab in the agent\u2019s browser' }
  ]
}

// Until this release the three arrived on one switch, so `true` may still be saved from that build: it
// meant all of them.
export function addOnsOf(value: BrowserAddOns | boolean | null | undefined): BrowserAddOns {
  if (value === true) return { ads: true, cookies: true, consent: true }
  return value && typeof value === 'object' ? value : {}
}

export const addOnOn = (value: BrowserAddOns | boolean | null | undefined, key: AddOn): boolean => !!addOnsOf(value)[key]
