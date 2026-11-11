// The image models in Settings › Local models: a switch each, off until the person turns it on.
// Turning one on downloads it the first time (to a folder every workspace shares: downloaded in one,
// another only turns it on); from then on, what's attached to a message is read here and goes to
// the agents as text instead of as an image.
import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { localModelsRefusal } from '../../../shared/voice'
import { localModelCancelDownload, localModelDownload, localModelRemove, localModelsStatus, openExternal, updateSettings, useStore, LOCAL_MODEL_IDS, LOCAL_TYPE_FORMATS, LOCAL_TYPES_ALWAYS, LOCAL_TYPES_EXTRA, localOnly, type LocalModelId, type LocalModelPath, type LocalModelsSettings, type LocalModelsStatus } from '../store'
import { confirmDialog } from './Dialogs'
import { Card, Field, Toggle } from './Pages'
import { Icon, type IconName } from './ui'

// Each model's license, linked: two are Apache-2.0 like Tucano; OmniParser's detector is AGPL-3.0,
// which it inherits from YOLO, and that is said where it's turned on.
interface License {
  name: string
  url: string
  note?: string
}
// memory: the most it took while reading, measured through the app's own code on a 1440×900
// screenshot and a 2048×2560 photo (onnxruntime keeps it until the models go idle, IDLE_MS).
export const LOCAL_MODEL_INFO = (): Record<LocalModelId, { name: string; model: string; size: string; about: string; memory: string; icon: IconName; license: License }> => ({
  ocr: {
    icon: 'book',
    name: L('Ler texto', 'Read text'),
    model: 'PP-OCRv6',
    size: '23 MB',
    about: L('O texto de imagens e de PDFs escaneados.', 'The text in images and scanned PDFs.'),
    memory: L('Usa até ~600 MB de memória enquanto lê.', 'Uses up to ~600 MB of memory while reading.'),
    license: { name: 'Apache-2.0', url: 'https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE' }
  },
  ui: {
    icon: 'pointer',
    name: L('Elementos de tela', 'Screen elements'),
    model: 'OmniParser v2',
    size: '80 MB',
    about: L('Botões, links, campos e cartões num print de tela.', 'Buttons, links, fields and cards in a screenshot.'),
    memory: L(
      'Usa até ~400 MB de memória enquanto lê, mais os ~600 MB do Ler texto se ele estiver baixado (lê o texto dos botões com ele).',
      'Uses up to ~400 MB of memory while reading, plus Read text’s ~600 MB if that is downloaded (it reads the text in buttons with it).'
    ),
    license: {
      name: 'AGPL-3.0',
      url: 'https://huggingface.co/microsoft/OmniParser-v2.0/blob/main/icon_detect/LICENSE',
      note: L(
        'Licença AGPL-3.0, herdada do YOLO: não é a mesma do Tucano (Apache-2.0). Baixado só quando você ativa. Leia antes de usar num produto seu.',
        "AGPL-3.0 license, inherited from YOLO: not the same as Tucano's (Apache-2.0). Downloaded only when you turn it on. Read it before using it in a product of your own."
      )
    }
  },
  objects: {
    icon: 'eye',
    name: L('Objetos', 'Objects'),
    model: 'DEIMv2-N',
    size: '15 MB',
    about: L('O que tem numa foto: pessoas, carros, animais, objetos.', "What's in a photo: people, cars, animals, things."),
    memory: L('Usa até ~400 MB de memória enquanto lê.', 'Uses up to ~400 MB of memory while reading.'),
    license: { name: 'Apache-2.0', url: 'https://huggingface.co/LibreYOLO/LibreDEIMv2n/blob/654e96783419a45fb4cd30d0086fa81c51cbb5fa/LICENSE' }
  }
})

// The models' state, read again whenever the core says it changed.
export function useLocalModels(): LocalModelsStatus | null {
  const rev = useStore((s) => s.localModelsRev)
  const paths = useStore((s) => s.settings.localModels?.paths)
  const [status, setStatus] = useState<LocalModelsStatus | null>(null)
  useEffect(() => void localModelsStatus().then(setStatus), [rev, paths])
  return status
}

const mb = (n: number): string => `${Math.round(n / 1_000_000)} MB`

function ModelRow({ id, status, on, save }: { id: LocalModelId; status: LocalModelsStatus; on: boolean; save: (patch: LocalModelsSettings) => void }): ReactNode {
  const info = LOCAL_MODEL_INFO()[id]
  const ready = status.ready.includes(id)
  const d = status.downloading?.model === id ? status.downloading : undefined
  const waiting = !!status.waiting?.includes(id)
  const error = status.error?.model === id ? status.error.message : undefined
  // Turning one off deletes what was downloaded (it's 15–80 MB), after asking: using it again means
  // downloading it again. A model of one's own (Advanced) is the person's file: never deleted.
  const flip = async (next: boolean): Promise<void> => {
    if (next) {
      save({ [id]: true })
      if (!ready && !d && !waiting) void localModelDownload(id)
      return
    }
    if (d || waiting) return save({ [id]: false }), void localModelCancelDownload(id)
    if (status.stored.includes(id)) {
      if (!(await confirmDelete(true))) return
      save({ [id]: false })
      return void localModelRemove(id)
    }
    save({ [id]: false })
  }
  const confirmDelete = (turningOff: boolean): Promise<boolean> =>
    confirmDialog({
      title: turningOff ? L(`Desativar ${info.name}?`, `Turn off ${info.name}?`) : L(`Apagar ${info.name}?`, `Delete ${info.name}?`),
      body: L(
        `O modelo ${info.model} (${info.size}) será apagado deste computador, em todos os espaços de trabalho. Para usar de novo, ele precisa ser baixado outra vez.`,
        `The ${info.model} model (${info.size}) will be deleted from this computer, in every workspace. To use it again, it has to be downloaded again.`
      ),
      confirm: turningOff ? L('Desativar e apagar', 'Turn off and delete') : L('Apagar', 'Delete'),
      danger: true
    })
  return (
    <div className={`local-model ${on ? 'is-on' : ''}`}>
      <div className="local-model__head">
        <span className="local-model__icon" aria-hidden>
          <Icon name={info.icon} size={16} />
        </span>
        <div>
          <b>{info.name}</b> <span className="local-tag">{info.model}</span>
          <button type="button" className={`local-tag local-license ${info.license.note ? 'is-other' : ''}`} title={L(`Licença ${info.license.name}: abrir`, `${info.license.name} license: open`)} onClick={() => openExternal(info.license.url)}>
            {info.license.name}
          </button>
          <p className="small muted">{info.about}</p>
          <p className="local-model__memory small muted">{info.memory}</p>
          {info.license.note && (
            <p className="local-model__license small">
              <Icon name="shield" size={12} /> {info.license.note}
            </p>
          )}
        </div>
        <Toggle on={on} onChange={(v) => void flip(v)} />
      </div>
      {d ? (
        <div className="voice-setup">
          <div className="voice-setup__bar" role="progressbar" aria-valuemin={0} aria-valuemax={d.total} aria-valuenow={d.received}>
            <i style={{ width: `${Math.min(100, (d.received / d.total) * 100)}%` }} />
          </div>
          <div className="voice-setup__row">
            <span className="small muted">
              {L('Baixando', 'Downloading')} · {mb(d.received)} {L('de', 'of')} {mb(d.total)}
            </span>
            <button className="btn btn--ghost btn--xs" onClick={() => void localModelCancelDownload(id)}>
              {L('Cancelar', 'Cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="local-model__state small muted">
          {!on && !ready && <span>{info.size}</span>}
          {on && ready && status.devices[id] && <span>{status.devices[id]}</span>}
          {!on && ready && <span>{L('Baixado', 'Downloaded')}</span>}
          {waiting && (
            <>
              <span>{L('Na fila para baixar', 'Waiting to download')}</span>
              <button className="btn btn--ghost btn--xs" onClick={() => void localModelCancelDownload(id)}>
                {L('Cancelar', 'Cancel')}
              </button>
            </>
          )}
          {on && !ready && !error && !waiting && (
            <>
              <span>{L('Não baixado', 'Not downloaded')}</span>
              <button className="btn btn--xs" onClick={() => void localModelDownload(id)}>
                {L(`Baixar (${info.size})`, `Download (${info.size})`)}
              </button>
            </>
          )}
          {error && (
            <>
              <span className="field__error">{error}</span>
              <button className="btn btn--xs" onClick={() => void localModelDownload(id)}>
                {L('Tentar de novo', 'Try again')}
              </button>
            </>
          )}
          {!on && status.stored.includes(id) && (
            <button className="text-btn small" onClick={() => void confirmDelete(false).then((ok) => void (ok && localModelRemove(id)))}>
              {L('Remover', 'Remove')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const PATHS = (): { key: LocalModelPath; label: string; placeholder: string }[] => [
  { key: 'ocrDet', label: L('PP-OCR: detector de texto (.onnx)', 'PP-OCR: text detector (.onnx)'), placeholder: L('/caminho/PP-OCRv6_medium_det/inference.onnx', '/path/PP-OCRv6_medium_det/inference.onnx') },
  { key: 'ocrRec', label: L('PP-OCR: reconhecedor de texto (.onnx)', 'PP-OCR: text recognizer (.onnx)'), placeholder: L('/caminho/PP-OCRv6_medium_rec/inference.onnx', '/path/PP-OCRv6_medium_rec/inference.onnx') },
  { key: 'ocrDict', label: L('PP-OCR: caracteres do reconhecedor (inference.yml ou .txt)', "PP-OCR: the recognizer's characters (inference.yml or .txt)"), placeholder: L('/caminho/PP-OCRv6_medium_rec/inference.yml', '/path/PP-OCRv6_medium_rec/inference.yml') },
  { key: 'ui', label: L('Elementos de tela: detector YOLO (.onnx)', 'Screen elements: YOLO detector (.onnx)'), placeholder: L('/caminho/icon_detect.onnx', '/path/icon_detect.onnx') },
  { key: 'objects', label: L('Objetos: detector em ONNX (DEIMv2, D-FINE, RT-DETR ou YOLO)', 'Objects: detector in ONNX (DEIMv2, D-FINE, RT-DETR or YOLO)'), placeholder: L('/caminho/deimv2-s.onnx', '/path/deimv2-s.onnx') }
]

// The top of the view: what these are and where they run (the title is the view's button above).
export function LocalModelsIntro(): ReactNode {
  const status = useLocalModels()
  const facts: { icon: IconName; text: string }[] = [
    { icon: 'lock', text: L('Nada sai do computador', 'Nothing leaves the computer') },
    { icon: 'zap', text: L('Sem custo', 'Free') },
    { icon: 'layers', text: L('Baixados uma vez para todos os espaços de trabalho', 'Downloaded once for every workspace') },
    { icon: 'laptop', text: status?.gpu ? `${status.gpu} · CPU` : 'CPU' }
  ]
  return (
    <ul className="local-facts">
      {facts.map((f) => (
        <li key={f.icon}>
          <Icon name={f.icon} size={13} /> {f.text}
        </li>
      ))}
    </ul>
  )
}

// The file types the models read: JPG, PNG, WebP and PDF always (locked chips); others the person
// adds, and can take off. What a file is comes from its bytes, so "jpg" also covers a JPEG named
// .jpeg, or with no name at all.
function FileTypes({ added, keptHere, onChange }: { added: string[]; keptHere: boolean; onChange: (types: string[]) => void }): ReactNode {
  const outside = keptHere ? L('Um tipo fora da lista não é lido nem enviado para a IA.', "A type not on the list isn't read, nor sent to the AI.") : L('Um tipo fora da lista vai direto para a IA.', 'A type not on the list goes straight to the AI.')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const all = [...LOCAL_TYPES_ALWAYS, ...added]
  const format = (t: string): string => LOCAL_TYPE_FORMATS[t]!
  const missing = LOCAL_TYPES_EXTRA.filter((t) => !all.some((x) => format(x) === format(t)))
  const add = (raw: string): void => {
    // ".TIF", "image/tiff" and "tiff" are all the same thing typed differently
    const t = raw.trim().toLowerCase().replace(/^\./, '').replace(/^(image|application)\//, '')
    if (!t) return
    if (!Object.hasOwn(LOCAL_TYPE_FORMATS, t)) return setError(L(`Os modelos locais não leem "${t}". Dá pra adicionar: ${LOCAL_TYPES_EXTRA.join(', ')}.`, `The local models don't read "${t}". You can add: ${LOCAL_TYPES_EXTRA.join(', ')}.`))
    setError('')
    setDraft('')
    if (!all.some((x) => format(x) === format(t))) onChange([...added, t])
  }
  return (
    <div className="field">
      <span className="field__label">{L('Tipos lidos aqui', 'Types read here')}</span>
      <div className="type-chips">
        {LOCAL_TYPES_ALWAYS.map((t) => (
          <span key={t} className="type-chip is-fixed" title={L('Sempre lido', 'Always read')}>
            {t}
            <Icon name="lock" size={10} />
          </span>
        ))}
        {added.map((t) => (
          <span key={t} className="type-chip">
            {t}
            <button type="button" aria-label={L(`Tirar ${t}`, `Remove ${t}`)} onClick={() => onChange(added.filter((x) => x !== t))}>
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
        {missing.length > 0 && (
          <input
            className="type-chips__input"
            list="local-types"
            value={draft}
            placeholder={L('Adicionar…', 'Add…')}
            aria-label={L('Adicionar tipo', 'Add a type')}
            onChange={(e) => (setDraft(e.target.value), setError(''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') e.preventDefault(), add(draft)
              if (e.key === 'Backspace' && !draft && added.length) onChange(added.slice(0, -1))
            }}
            onBlur={() => draft && add(draft)}
          />
        )}
        <datalist id="local-types">
          {missing.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </div>
      {error ? <span className="field__error">{error}</span> : <span className="hint">{missing.length ? `${L(`Dá pra adicionar ${missing.join(', ')}.`, `You can add ${missing.join(', ')}.`)} ${outside}` : outside}</span>}
    </div>
  )
}

// "Never send images to the AI": only what the models read goes, never the image (nor ver_imagem).
// Holds only with a model on to read them: with none, it's shown off and can't be turned on.
function KeepImagesHere({ local, save }: { local: LocalModelsSettings | undefined; save: (patch: LocalModelsSettings) => void }): ReactNode {
  const anyOn = LOCAL_MODEL_IDS.some((id) => local?.[id])
  const on = localOnly(local)
  const label = L('Nunca enviar imagens para a IA', 'Never send images to the AI')
  return (
    <div className={`local-model ${on ? 'is-on' : ''} ${anyOn ? '' : 'is-off-limits'}`}>
      <div className="local-model__head">
        <span className="local-model__icon" aria-hidden>
          <Icon name="shield" size={16} />
        </span>
        <div>
          <b>{label}</b>
          <p className="small muted">
            {anyOn
              ? L(
                  'Só o que os modelos leram vai para o agente. Se não acharem nada, ele só fica sabendo que tem uma imagem. A ferramenta ver_imagem fica bloqueada.',
                  'Only what the models read goes to the agent. If they find nothing, it only learns there is an image. The ver_imagem tool is blocked.'
                )
              : L('Ative um modelo acima para usar.', 'Turn on a model above to use this.')}
          </p>
        </div>
        <Toggle on={on} disabled={!anyOn} label={label} onChange={(offline) => save({ offline })} />
      </div>
    </div>
  )
}

export function ImageModelsCard(): ReactNode {
  const local = useStore((s) => s.settings.localModels)
  const status = useLocalModels()
  const [error, setError] = useState('')
  const save = (patch: LocalModelsSettings): void => {
    const next = { ...local, ...patch }
    const why = localModelsRefusal(next)
    setError(why ?? '')
    if (!why) updateSettings({ localModels: next })
  }
  const setPath = (key: LocalModelPath, value: string): void => {
    const paths = { ...local?.paths }
    if (value) paths[key] = value
    else delete paths[key]
    save({ paths })
  }
  const custom = Object.values(local?.paths ?? {}).filter(Boolean).length
  return (
    <Card
      title={L('Imagens e PDFs', 'Images and PDFs')}
      lead={
        localOnly(local)
          ? L('O que você anexa é lido aqui e vai ao agente como texto. A imagem nunca vai para a IA.', 'What you attach is read here and goes to the agent as text. The image never goes to the AI.')
          : L('O que você anexa é lido aqui e vai ao agente como texto, no lugar da imagem. Se não der para ler, a imagem vai como sempre.', "What you attach is read here and goes to the agent as text, in place of the image. If it can't be read, the image goes as always.")
      }
    >
      {status && (
        <div className="local-models">
          {LOCAL_MODEL_IDS.map((id) => (
            <ModelRow key={id} id={id} status={status} on={!!local?.[id]} save={save} />
          ))}
          <p className="hint local-models__memory">
            {L(
              'Os três juntos usam até ~1 GB de memória enquanto leem. Ela volta para o computador depois de 5 minutos sem uso.',
              'All three together use up to ~1 GB of memory while reading. It goes back to the computer after 5 minutes unused.'
            )}
          </p>
          <KeepImagesHere local={local} save={save} />
          <FileTypes added={local?.types ?? []} keptHere={localOnly(local)} onChange={(types) => save({ types })} />
          {status.queued > 0 && (
            <p className="local-models__queue small">
              <Icon name="clock" size={13} /> {L(`${status.queued} na fila`, `${status.queued} in the queue`)}
            </p>
          )}
          <details className="voice-advanced">
            <summary className="small muted">
              {L('Avançado', 'Advanced')}
              {custom > 0 && ` · ${L(`${custom} em uso`, `${custom} in use`)}`}
            </summary>
            <p className="small muted">{L('Um modelo seu (.onnx) no lugar do que o app baixa. Vazio: o do app.', "A model of your own (.onnx) in place of the app's. Empty: the app's.")}</p>
            {PATHS().map((p, i) => (
              <Field key={p.key} label={p.label} {...(i === PATHS().length - 1 ? { error } : {})}>
                <input defaultValue={local?.paths?.[p.key] ?? ''} placeholder={p.placeholder} onBlur={(e) => setPath(p.key, e.target.value.trim())} />
              </Field>
            ))}
          </details>
        </div>
      )}
    </Card>
  )
}
