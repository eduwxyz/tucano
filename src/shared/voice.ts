import { L } from './lang'
import type { VoiceSettings } from './types'

const absolute = (p: string): boolean => /^(\/|[a-zA-Z]:[\\/])/.test(p)

// Only an absolute path to a whisper binary: this setting is run as a program.
export function voiceRefusal(voice: VoiceSettings | undefined): string | null {
  if (voice?.bin && (!absolute(voice.bin) || !/^whisper/i.test(voice.bin.split(/[\\/]/).pop() ?? ''))) return L('Use o caminho completo do whisper-cli.', 'Use the full path to whisper-cli.')
  if (voice?.model && (!absolute(voice.model) || !voice.model.endsWith('.bin'))) return L('Use o caminho completo do modelo, um arquivo .bin.', 'Use the full path to the model, a .bin file.')
  return null
}
