import type { ComposerDraft, DraftApi, DraftEntries } from '../../shared/drafts'
import { MAX_IMAGES_PER_MESSAGE, type ImageUpload } from '../../shared/types'

// Browser sessions retain the original in-memory behavior. Desktop pages also
// checkpoint into main-process memory before an environment switch or reload.
export class ComposerDrafts {
  private readonly entries: Map<string, ComposerDraft>
  private active?: { id: string; read(): ComposerDraft; write?(draft: ComposerDraft): void }
  private readonly pendingAttachments = new Map<string, number>()
  private readonly sending = new Map<string, { pending: boolean; revision: number; error: boolean }>()
  private readonly listeners = new Set<() => void>()
  private readonly idle = { pending: false, revision: 0, error: false }

  constructor(api?: DraftApi) {
    this.entries = new Map(api?.read() ?? [])
    api?.onCheckpoint(() => this.checkpoint())
  }
  get(id: string): ComposerDraft | undefined { return this.entries.get(id) }
  delete(id: string): void { this.entries.delete(id) }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed(): void { for (const listener of this.listeners) listener() }
  sendState(id: string): { pending: boolean; revision: number; error: boolean } { return this.sending.get(id) ?? this.idle }
  async send(id: string, draft: ComposerDraft, action: () => Promise<void>): Promise<void> {
    const previous = this.sendState(id)
    if (previous.pending || this.preparingState(id)) return
    this.save(id, draft)
    this.sending.set(id, { ...previous, pending: true, error: false }); this.changed()
    try {
      await action()
      this.entries.delete(id)
      this.sending.set(id, { pending: false, revision: previous.revision + 1, error: false })
    } catch {
      // A failed acknowledgment may still mean the server received the message.
      // Keep the draft for review; never automatically replay it.
      this.sending.set(id, { ...previous, pending: false, error: true })
    }
    this.changed()
  }
  private save(id: string, draft: ComposerDraft): void {
    if (draft.text || draft.images.length) this.entries.set(id, draft)
    else this.entries.delete(id)
  }
  activate(id: string, read: () => ComposerDraft, write?: (draft: ComposerDraft) => void): () => void {
    const active = { id, read, write }
    this.active = active
    return () => {
      this.save(id, read())
      if (this.active === active) this.active = undefined
    }
  }
  preparingState(id: string): number { return this.pendingAttachments.get(id) ?? 0 }
  preparingAttachment(id: string): () => void {
    this.pendingAttachments.set(id, this.preparingState(id) + 1); this.changed()
    return () => {
      const pending = this.preparingState(id) - 1
      if (pending > 0) this.pendingAttachments.set(id, pending)
      else this.pendingAttachments.delete(id)
      this.changed()
    }
  }
  appendImages(id: string, images: ImageUpload[]): boolean {
    const active = this.active?.id === id ? this.active : undefined
    const previous = active?.read() ?? this.entries.get(id) ?? { text: '', images: [] }
    const next = { text: previous.text, images: [...previous.images, ...images].slice(0, MAX_IMAGES_PER_MESSAGE) }
    // Save to the captured conversation before conversion is marked complete.
    // A different conversation can be on screen by the time an image decodes.
    this.save(id, next)
    active?.write?.(next)
    return previous.images.length + images.length > MAX_IMAGES_PER_MESSAGE
  }
  checkpoint(): DraftEntries {
    // Wait for image conversion rather than silently dropping an attachment.
    if (this.pendingAttachments.size) throw new Error('Images are still being prepared.')
    if ([...this.sending.values()].some((state) => state.pending)) throw new Error('A message is still being sent.')
    if (this.active) this.save(this.active.id, this.active.read())
    return [...this.entries].map(([id, draft]) => [id, { text: draft.text, images: draft.images.map(({ name, mime, data }) => ({ name, mime, data })) }])
  }
}
