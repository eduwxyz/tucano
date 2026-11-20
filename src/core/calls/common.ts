// Small things the calls service and its helpers share.
export const STATE_KEY = 'calls:state' // the provider's state for a number, sealed in `auth`
export const MAX_LIVE = 3 // calls on at once on one number

export const digits = (s: string | undefined): string => (s ?? '').replace(/\D/g, '')
export const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
