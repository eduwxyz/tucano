import type { ImageUpload } from './types'

// Session-only drafts. Native storage never writes these to disk or sends them to a VPS.
export type ComposerDraft = { text: string; images: ImageUpload[] }
export type DraftEntries = [string, ComposerDraft][]
export type DraftApi = {
  read(): DraftEntries
  onCheckpoint(read: () => DraftEntries): () => void
}
