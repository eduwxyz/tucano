// The clock the app reads: 24 hours, or 12 with am/pm, the person's choice in Settings › The
// conversation. Both processes keep it here, next to the language, so a time in a reply, in a
// routine's schedule and in the context handed to an agent all read the same way. Untouched, it
// keeps what the app did before there was a choice: 24 hours, except an English install, which
// read message times as the browser does for en-US.
import { lang } from './lang'

export type Clock = '24' | '12'

let current: Clock | undefined // unset: the app's own reading, by language

export const setClock = (clock: Clock | undefined): void => {
  current = clock === '12' || clock === '24' ? clock : undefined
}
export const clock = (): Clock => current ?? (lang() === 'en' ? '12' : '24')
export const hour12 = (): boolean => clock() === '12'
// The hour's own shape: a 12-hour clock reads 3:05 PM, a 24-hour one 15:05.
export const hourStyle = (): 'numeric' | '2-digit' => (hour12() ? 'numeric' : '2-digit')

// Every time the app draws or writes goes through here, so `hour12` is decided in one place and
// the language only picks the locale (the separator, the month's name).
export const timeOpts = (opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions => ({ ...opts, hour12: hour12() })
