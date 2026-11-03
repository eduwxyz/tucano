import { randomUUID } from 'node:crypto'
import { IMAGE_MIMES, MAX_IMAGES_PER_MESSAGE } from '../shared/types'
import type { DraftEntries } from '../shared/drafts'

export type DraftSaveResult = 'saved' | 'forgotten' | 'invalid'
type Scope = { profile: string | null; entries: DraftEntries }

function validated(value: unknown): DraftEntries | undefined {
  if (!Array.isArray(value) || value.length > 256) return
  let size = 0
  const ids = new Set<string>(), entries: DraftEntries = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return
    const [id, draft] = entry
    if (typeof id !== 'string' || !id || id.length > 256 || ids.has(id) || !draft || typeof draft !== 'object' ||
      typeof draft.text !== 'string' || draft.text.length > 1_000_000 || !Array.isArray(draft.images) || draft.images.length > MAX_IMAGES_PER_MESSAGE) return
    ids.add(id); size += draft.text.length
    const images = []
    for (const image of draft.images) {
      if (!image || typeof image !== 'object' || typeof image.name !== 'string' || image.name.length > 1024 ||
        !IMAGE_MIMES.includes(image.mime) || typeof image.data !== 'string' || image.data.length > 5_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return
      size += image.data.length
      images.push({ name: image.name, mime: image.mime, data: image.data })
    }
    if (size > 128 * 1024 * 1024) return
    if (draft.text || images.length) entries.push([id, { text: draft.text, images }])
  }
  return entries
}

export class SessionDrafts {
  private readonly scopes = new Map<string, Scope>()
  private readonly sessions = new Map<string, string | null>()

  open(profile: string | null, server?: string): { session: string; entries: DraftEntries } {
    const scope = JSON.stringify([profile, profile === null ? null : server])
    if (!this.scopes.has(scope)) this.scopes.set(scope, { profile, entries: [] })
    for (const [session, saved] of this.sessions) if (saved === scope) this.sessions.set(session, null)
    const session = randomUUID()
    this.sessions.set(session, scope)
    return { session, entries: structuredClone(this.scopes.get(scope)!.entries) }
  }

  save(session: string, value: unknown): DraftSaveResult {
    const scope = this.sessions.get(session)
    if (scope === null) return 'forgotten'
    if (scope === undefined) return 'invalid'
    const entries = validated(value)
    if (!entries) return 'invalid'
    this.scopes.get(scope)!.entries = entries
    return 'saved'
  }

  forget(profile: string): void {
    for (const [key, scope] of this.scopes) if (scope.profile === profile) {
      this.scopes.delete(key)
      // An old page may still unload after Forget. It must not resurrect this data.
      for (const [session, saved] of this.sessions) if (saved === key) this.sessions.set(session, null)
    }
  }
}
