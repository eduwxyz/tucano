// Where a link may take the person. The app's window only ever shows the app: a link
// opens in the real browser or the mail app, and anything else (a bare path, file:,
// javascript:, the app's own tucano: pages) goes nowhere. A local page loaded as the
// app would get the app's bridge to the core.

export const isOutsideLink = (url: string): boolean => /^(https?:\/\/|mailto:)/i.test(url)

// The app's own page, again (a reload, or the same page with another #hash). appPage is
// the dev server's URL while developing, the built index.html's file: URL otherwise.
export function isAppPage(url: string, appPage: string): boolean {
  try {
    const u = new URL(url)
    const app = new URL(appPage)
    if (u.protocol === 'file:' || app.protocol === 'file:') return u.protocol === app.protocol && u.pathname === app.pathname && u.host === app.host
    return u.origin === app.origin
  } catch {
    return false
  }
}

// What a page in the default session may be given. Only the app's own page, in its main frame (not a
// frame or a service shown inside it), gets a permission; the microphone only for dictation (audio);
// and asking the system to open something goes only for a link that may leave the app.
export function appMayHave(
  o: { permission: string; requestingUrl?: string; isMainFrame?: boolean; fromWindow: boolean; mediaTypes?: readonly string[]; externalURL?: string },
  appPage: string
): boolean {
  if (o.permission === 'openExternal') return isOutsideLink(o.externalURL ?? '')
  const own = o.fromWindow && o.isMainFrame === true && isAppPage(o.requestingUrl ?? '', appPage)
  if (o.permission === 'media') return own && !!o.mediaTypes?.length && o.mediaTypes.every((t) => t === 'audio')
  return own
}

// The same, when the page only checks whether it has one (Notification.permission, a query).
export const appMayCheck = (o: { permission: string; requestingUrl?: string; isMainFrame?: boolean; fromWindow: boolean }, appPage: string): boolean =>
  o.permission !== 'openExternal' && o.fromWindow && o.isMainFrame !== false && isAppPage(o.requestingUrl ?? '', appPage)
