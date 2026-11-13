import { L } from './lang'
import { LOCAL_TYPE_FORMATS, type LocalModelsSettings, type VoiceSettings } from './types'

const absolute = (p: string): boolean => /^(\/|[a-zA-Z]:[\\/])/.test(p)

// Only an absolute path to a whisper binary: this setting is run as a program.
export function voiceRefusal(voice: VoiceSettings | undefined): string | null {
  if (voice?.bin && (!absolute(voice.bin) || !/^whisper/i.test(voice.bin.split(/[\\/]/).pop() ?? ''))) return L('Use o caminho completo do whisper-cli.', 'Use the full path to whisper-cli.')
  if (voice?.model && (!absolute(voice.model) || !voice.model.endsWith('.bin'))) return L('Use o caminho completo do modelo, um arquivo .bin.', 'Use the full path to the model, a .bin file.')
  return null
}

// A model of one's own: an absolute path to an .onnx file (the characters: a .yml or .txt).
export function localModelsRefusal(m: LocalModelsSettings | undefined): string | null {
  if (m?.offline !== undefined && typeof m.offline !== 'boolean') return L('Opção inválida.', 'Invalid option.')
  if (m?.types !== undefined) {
    if (!Array.isArray(m.types) || m.types.length > 20) return L('Lista de tipos inválida.', 'Invalid list of types.')
    const bad = m.types.find((t) => typeof t !== 'string' || !Object.hasOwn(LOCAL_TYPE_FORMATS, t))
    if (bad !== undefined) return L(`Os modelos locais não leem "${bad}". Dá pra usar: ${Object.keys(LOCAL_TYPE_FORMATS).join(', ')}.`, `The local models don't read "${bad}". These work: ${Object.keys(LOCAL_TYPE_FORMATS).join(', ')}.`)
  }
  for (const [key, path] of Object.entries(m?.paths ?? {})) {
    if (!path) continue
    const ok = key === 'ocrDict' ? /\.(ya?ml|txt)$/i.test(path) : /\.onnx$/i.test(path)
    if (!absolute(path) || !ok) return key === 'ocrDict' ? L('Use o caminho completo dos caracteres: o inference.yml do modelo ou um .txt.', "Use the full path to the characters: the model's inference.yml or a .txt.") : L('Use o caminho completo do modelo, um arquivo .onnx.', 'Use the full path to the model, an .onnx file.')
  }
  return null
}
