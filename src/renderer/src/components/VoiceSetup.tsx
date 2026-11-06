// Turning dictation on: pick a model, and the app downloads it, with a bar and a way to stop.
// The same piece in the balloon over the microphone and in Settings.
import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { updateSettings, useStore, voiceCancelDownload, voiceDownload, voiceStatus, type VoiceModelId, type VoiceStatus } from '../store'
import { Icon } from './ui'

export const VOICE_CHOICES = (): { id: VoiceModelId; name: string; size: string; about: string }[] => [
  { id: 'recommended', name: L('Recomendado', 'Recommended'), size: '574 MB', about: L('O mais preciso, inclusive em português.', 'The most accurate, in any language.') },
  { id: 'light', name: L('Leve', 'Light'), size: '190 MB', about: L('Baixa mais rápido e erra um pouco mais.', 'Downloads faster, and gets a bit more wrong.') }
]

// Dictation's state, read again whenever the core says it changed.
export function useVoice(): VoiceStatus | null {
  const rev = useStore((s) => s.voiceRev)
  const voice = useStore((s) => s.settings.voice)
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  useEffect(() => void voiceStatus().then(setStatus), [rev, voice])
  return status
}

const mb = (n: number): string => `${Math.round(n / 1_000_000)} MB`

export function VoiceSetup({ status }: { status: VoiceStatus }): ReactNode {
  const [pick, setPick] = useState<VoiceModelId>('recommended')
  const d = status.downloading
  if (d)
    return (
      <div className="voice-setup">
        <div className="voice-setup__bar" role="progressbar" aria-valuemin={0} aria-valuemax={d.total} aria-valuenow={d.received}>
          <i style={{ width: `${Math.min(100, (d.received / d.total) * 100)}%` }} />
        </div>
        <div className="voice-setup__row">
          <span className="small muted">
            {L('Baixando o modelo de voz', 'Downloading the voice model')} · {mb(d.received)} {L('de', 'of')} {mb(d.total)}
          </span>
          <button className="btn btn--ghost btn--xs" onClick={() => void voiceCancelDownload()}>
            {L('Cancelar', 'Cancel')}
          </button>
        </div>
      </div>
    )
  return (
    <div className="voice-setup">
      <div className="voice-setup__choices" role="radiogroup">
        {VOICE_CHOICES().map((c) => (
          <button key={c.id} type="button" role="radio" aria-checked={pick === c.id} className={`voice-choice ${pick === c.id ? 'is-on' : ''}`} onClick={() => setPick(c.id)}>
            <span>
              <b>{c.name}</b> <span className="muted">· {c.size}</span>
            </span>
            <small>{c.about}</small>
          </button>
        ))}
      </div>
      {status.error && <p className="field__error">{status.error}</p>}
      <button className="btn btn--primary btn--sm" onClick={() => void voiceDownload(pick)}>
        <Icon name="mic" size={13} /> {status.error ? L('Tentar de novo', 'Try again') : L('Ativar ditado', 'Turn dictation on')}
      </button>
    </div>
  )
}

// Over the microphone, the first time: what it is, and the way to turn it on (or not see it again).
export function VoicePopover({ status, onClose }: { status: VoiceStatus; onClose: () => void }): ReactNode {
  const platform = useStore((s) => s.platform)
  const voice = useStore((s) => s.settings.voice)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => void (e.key === 'Escape' && onClose())
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const key = platform === 'mac' ? '⌥ Espaço' : 'Ctrl+Espaço'
  return (
    <div className="voice-pop" role="dialog" aria-label={L('Ditar mensagens', 'Dictate messages')}>
      <button className="voice-pop__close icon-btn" aria-label={L('Fechar', 'Close')} onClick={onClose}>
        <Icon name="x" size={13} />
      </button>
      {status.ready ? (
        <>
          <b>{L('Pronto para ditar', 'Ready to dictate')}</b>
          <p className="small muted">{L(`Clique no microfone, ou ${key}, e fale. Clique de novo para terminar: o texto aparece aqui para você revisar. Na primeira vez, o sistema pede para liberar o microfone.`, `Click the microphone, or ${key.replace('Espaço', 'Space')}, and speak. Click again to finish: the text shows up here to review. The first time, the system asks to allow the microphone.`)}</p>
          <button className="btn btn--sm" onClick={onClose}>
            {L('Entendi', 'Got it')}
          </button>
        </>
      ) : (
        <>
          <b>{L('Ditar mensagens', 'Dictate messages')}</b>
          <p className="small muted">{L('Fale em vez de digitar. Funciona neste computador, sem internet e sem custo: nada do que você fala sai daqui. Precisa baixar um modelo de voz uma vez.', 'Speak instead of typing. It runs on this computer, offline and free: nothing you say leaves it. It needs a voice model, downloaded once.')}</p>
          <VoiceSetup status={status} />
          <button className="text-btn voice-pop__hide" onClick={() => (onClose(), updateSettings({ voice: { ...voice, hidden: true } }))}>
            {L('Não mostrar o microfone', "Don't show the microphone")}
          </button>
        </>
      )}
    </div>
  )
}
