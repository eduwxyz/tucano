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
