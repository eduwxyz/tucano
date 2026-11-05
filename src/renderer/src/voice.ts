// Records the microphone while held. An AudioContext at 16 kHz resamples what comes in, and
// ScriptProcessor needs no worklet file to load from the app's restricted origin.
import { encodeWav } from '../../shared/wav'

const RATE = 16_000
const SILENCE = 0.0005 // loudness below this is no sound at all: a muted or blocked microphone

// Given silence, whisper makes words up ("E aí"), and they'd land in the message.
export class NoSound extends Error {}

export interface Recording {
  stop(): Promise<string> // the WAV, in base64
  cancel(): void
}

export const canRecord = (): boolean => !!navigator.mediaDevices?.getUserMedia

export async function record(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  const context = new AudioContext({ sampleRate: RATE })
  const source = context.createMediaStreamSource(stream)
  const node = context.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
  source.connect(node)
  node.connect(context.destination)
  const finish = (): void => {
    node.disconnect()
    source.disconnect()
    stream.getTracks().forEach((t) => t.stop())
    void context.close()
  }
  return {
    cancel: finish,
    stop: async () => {
      finish()
      const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
      let at = 0
      for (const c of chunks) {
        samples.set(c, at)
        at += c.length
      }
      if (Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / (samples.length || 1)) < SILENCE) throw new NoSound()
      let binary = ''
      const wav = encodeWav(samples, RATE)
      for (let i = 0; i < wav.length; i += 0x8000) binary += String.fromCharCode(...wav.subarray(i, i + 0x8000))
      return btoa(binary)
    }
  }
}
