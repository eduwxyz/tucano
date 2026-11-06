// A Databricks run an agent follows: the live card under its message, and the settings.
import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { commandWords, isFinal, isReadCommand, JOB_WATCH_DEFAULTS, jobWatchConfig, type DatabricksStatus, type JobState, type JobTask, type JobWatch, type JobWatchSettings } from '../../../shared/job-watch'
import { safeUrl } from '../links'
import { cancelJobRun, checkDatabricks, stopJobWatch, updateSettings, useStore } from '../store'
import { confirmDialog } from './Dialogs'
import { Card, Field, Toggle } from './Pages'
import { ago, duration, Icon, NumberInput } from './ui'

const bytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

const STATE_LABEL = (s: JobState): string =>
  ({
    queued: L('Na fila', 'Queued'),
    running: L('Rodando', 'Running'),
    terminating: L('Terminando', 'Finishing'),
    waiting_retry: L('Vai tentar de novo', 'Will retry'),
    succeeded: L('Concluído', 'Done'),
    failed: L('Falhou', 'Failed'),
    timed_out: L('Estourou o tempo', 'Timed out'),
    canceled: L('Cancelado', 'Canceled')
  })[s]

type Tone = 'live' | 'warn' | 'bad' | 'ok' | 'idle'

// What the card says at the top. A failed check is never the job's failure.
function headline(w: JobWatch): { label: string; tone: Tone } {
  const state = w.reading?.state
  if (w.readErrorKind === 'auth' || w.readErrorKind === 'no_cli' || w.readErrorKind === 'refused') return { label: L('Sem acesso', 'No access'), tone: 'warn' }
  if (w.status === 'ended' && !(state && isFinal(state))) {
    if (w.endReason === 'not_found') return { label: L('Não encontrado', 'Not found'), tone: 'bad' }
    if (w.endReason === 'max_time') return { label: L('Tempo máximo', 'Time limit'), tone: 'idle' }
    return { label: L('Sem acompanhamento', 'Not following'), tone: 'idle' }
  }
  if (w.signal) return { label: L('Possível travamento', 'Possible stall'), tone: 'warn' }
  if (!state) return { label: L('Na fila', 'Queued'), tone: 'live' }
  if (state === 'succeeded') return { label: STATE_LABEL(state), tone: 'ok' }
  if (state === 'failed' || state === 'timed_out') return { label: STATE_LABEL(state), tone: 'bad' }
  if (state === 'canceled') return { label: STATE_LABEL(state), tone: 'idle' }
  return { label: STATE_LABEL(state), tone: 'live' }
}

function TaskRow({ task, now }: { task: JobTask; now: number }): ReactNode {
  const failed = task.state === 'failed' || task.state === 'timed_out'
  const running = task.state === 'running' || task.state === 'terminating'
  const took = task.ms ?? (running && task.startedAt ? now - task.startedAt : undefined)
  return (
    <li className="job-card__task">
      <span className={`job-card__task-mark ${failed ? 'is-bad' : task.state === 'succeeded' ? 'is-ok' : ''}`}>
        {running ? <span className="job-card__dot job-card__dot--live" /> : <Icon name={task.state === 'succeeded' ? 'check' : failed ? 'x' : 'clock'} size={13} />}
      </span>
      <span className="job-card__task-name" title={task.error}>{task.key}</span>
      <span className="muted small">{[took !== undefined ? duration(took) : '', task.state === 'canceled' ? L('não rodou', "didn't run") : failed || task.state === 'waiting_retry' || task.state === 'queued' ? STATE_LABEL(task.state).toLowerCase() : ''].filter(Boolean).join(' · ')}</span>
    </li>
  )
}

export function JobWatchCard({ id }: { id: string }): ReactNode {
  const w = useStore((s) => s.jobWatches.find((x) => x.id === id))
  const actions = useStore((s) => jobWatchConfig(s.settings.jobWatch).actions)
  const live = w?.status === 'watching'
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])
  const [toggled, setToggled] = useState<boolean | null>(null)
  const [cancelError, setCancelError] = useState('')
  if (!w) return null

  const r = w.reading
  const head = headline(w)
  const started = r?.startedAt
  const took = started ? (r?.endedAt ?? w.endedAt ?? now) - started : undefined
  // Done, it folds to a line; everything else stays open, a failure above all.
  const open = toggled ?? r?.state !== 'succeeded'
  const spark = r?.spark
  const done = r?.tasks.filter((t) => t.state === 'succeeded').length ?? 0
  const unavailable = L('Indisponível', 'Unavailable')
  const stale = !live && spark ? spark.at < (r?.endedAt ?? w.readAt ?? 0) : false

  return (
    <div className={`job-card job-card--${head.tone}`}>
      <div className="job-card__head">
        <span className={`job-card__dot ${live && head.tone !== 'warn' ? 'job-card__dot--live' : ''}`} />
        <strong className="job-card__name">{r?.name ?? L(`Run ${w.runId}`, `Run ${w.runId}`)}</strong>
        <span className="muted small job-card__run">
          run {w.runId}
          {took !== undefined ? ` · ${duration(Math.max(0, took))}` : ''}
        </span>
        <span className="job-card__state">{head.label}</span>
      </div>

      {!open && (
        <button className="job-card__fold" onClick={() => setToggled(true)}>
          <span>
            {done} {L('de', 'of')} {r?.tasks.length ?? 0} tasks
          </span>
          <span className="job-card__chev"><Icon name="chevron" size={12} /></span>
          {L('Ver métricas', 'See metrics')}
        </button>
      )}

      {open && r && (
        <>
          <div className="job-card__metrics">
            <div>
              <small>Tasks</small>
              <b>{r.tasks.length ? `${done} ${L('de', 'of')} ${r.tasks.length}` : '-'}</b>
            </div>
            <div>
              <small>Shuffle</small>
              <b className={spark ? '' : 'is-none'}>{spark ? bytes(spark.shuffleBytes) : unavailable}</b>
            </div>
            <div className={w.spillHigh ? 'is-warn' : ''}>
              <small>Spill</small>
              <b className={spark ? '' : 'is-none'}>{spark ? bytes(spark.spillBytes) : unavailable}</b>
            </div>
            <div>
              <small>{L('Memória', 'Memory')}</small>
              <b className={spark?.memoryPercent !== undefined ? '' : 'is-none'}>{spark?.memoryPercent !== undefined ? `${spark.memoryPercent}%` : unavailable}</b>
            </div>
          </div>

          {live && spark && spark.tasksTotal > 0 && (
            <div className="job-card__stage">
              <span className="muted small">
                {L(`Etapa ${spark.stageId}`, `Stage ${spark.stageId}`)} · {spark.tasksDone} {L('de', 'of')} {spark.tasksTotal} tasks
              </span>
              <span className="job-card__bar" role="progressbar" aria-valuemin={0} aria-valuemax={spark.tasksTotal} aria-valuenow={spark.tasksDone}>
                <i style={{ transform: `scaleX(${Math.min(1, spark.tasksDone / spark.tasksTotal)})` }} />
              </span>
            </div>
          )}

          {r.tasks.length > 0 && <ol className="job-card__tasks">{r.tasks.map((t) => <TaskRow key={t.key} task={t} now={now} />)}</ol>}
          {r.message && !isFinal(r.state) && <p className="muted small job-card__line">{r.message}</p>}
          {r.tasks.filter((t) => t.error).map((t) => (
            <p key={t.key} className="job-card__line job-card__line--bad">
              {t.key}: {t.error}
            </p>
          ))}
        </>
      )}

      {w.analyzing && <p className="job-card__line job-card__analyzing shimmer">{L('O agente está analisando…', 'The agent is analyzing…')}</p>}
      {w.note && <p className="job-card__line job-card__line--warn">{w.note}</p>}
      {w.readError && (
        <p className="job-card__line job-card__line--warn">
          {w.readErrorKind === 'auth' ? (
            <>
              {L('O login expirou. Rode ', 'The login expired. Run ')}
              <code>databricks auth login</code>
            </>
          ) : (
            w.readError
          )}
        </p>
      )}
      {w.sparkError && (live || !spark) && <p className="muted small job-card__line">{L('Sem métricas do Spark: ', 'No Spark metrics: ')}{w.sparkError}</p>}
      {!w.sparkError && !spark && r && isFinal(r.state) && <p className="muted small job-card__line">{L('Shuffle, spill e memória só são lidos enquanto o run está rodando, e o cluster deste já encerrou. Acompanhe um run em andamento para vê-los.', 'Shuffle, spill and memory are only read while the run is going, and this one’s cluster has shut down. Follow a run in progress to see them.')}</p>}
      {!w.sparkError && !spark && r?.state === 'running' && !r.clusterId && <p className="muted small job-card__line">{L('Este run não mostra um cluster clássico, então não há API do Spark para ler. Em serverless, essas métricas não existem.', 'This run shows no classic cluster, so there’s no Spark API to read. On serverless, these metrics don’t exist.')}</p>}
      {w.gap && <p className="muted small job-card__line">{L(`Sem leituras por ${duration(w.gap.to - w.gap.from)}: as métricas desse intervalo ficaram de fora.`, `No readings for ${duration(w.gap.to - w.gap.from)}: metrics from that time are missing.`)}</p>}
      {w.endReason === 'max_time' && <p className="muted small job-card__line">{L('Parou de acompanhar no tempo máximo. O job pode continuar rodando.', 'Stopped following at the time limit. The job may still be running.')}</p>}
      {stale && r?.state !== 'succeeded' && <p className="muted small job-card__line">{L('Métricas lidas antes de o cluster encerrar.', 'Metrics read before the cluster shut down.')}</p>}
      {cancelError && <p className="job-card__line job-card__line--warn">{cancelError}</p>}

      {open && (
        <div className="job-card__foot">
          {r?.url && safeUrl(r.url, 'href') && (
            <a className="btn btn--xs btn--ghost" href={safeUrl(r.url, 'href')} target="_blank" rel="noreferrer">
              {L('Abrir no Databricks', 'Open in Databricks')}
            </a>
          )}
          {live && (
            <button className="btn btn--xs btn--ghost" onClick={() => stopJobWatch(w.id)} title={L('O job continua rodando', 'The job keeps running')}>
              {L('Parar de acompanhar', 'Stop following')}
            </button>
          )}
          {live && actions && (
            <button
              className="btn btn--xs btn--ghost"
              onClick={() =>
                void confirmDialog({
                  title: L(`Cancelar o run ${w.runId}?`, `Cancel run ${w.runId}?`),
                  body: L('O job para no Databricks. Isso não pode ser desfeito.', 'The job stops on Databricks. This can’t be undone.'),
                  confirm: L('Cancelar run', 'Cancel run'),
                  danger: true
                }).then((ok) => {
                  if (ok) cancelJobRun(w.id).catch((e: unknown) => setCancelError(e instanceof Error ? e.message : String(e)))
                })
              }
            >
              {L('Cancelar run', 'Cancel run')}
            </button>
          )}
          {w.readAt && <span className="muted small job-card__read">{L(`Última leitura ${ago(w.readAt, now)}`, `Last read ${ago(w.readAt, now)}`)}</span>}
        </div>
      )}
    </div>
  )
}

const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .filter(Boolean)

export function JobWatchSettingsCard(): ReactNode {
  const saved = useStore((s) => s.settings.jobWatch)
  const c = jobWatchConfig(saved)
  const set = (patch: Partial<JobWatchSettings>): void => updateSettings({ jobWatch: { ...saved, ...patch } })
  const [commands, setCommands] = useState(c.commands.join('\n'))
  const [paths, setPaths] = useState(c.apiPaths.join('\n'))
  const [check, setCheck] = useState<DatabricksStatus | 'checking' | null>(null)
  const detect = (): void => {
    setCheck('checking')
    checkDatabricks().then(setCheck, (e: unknown) => setCheck({ ok: false, text: e instanceof Error ? e.message : String(e), profiles: [] }))
  }
  // Nothing to fill in: it looks as the card opens, and again when a choice changes.
  useEffect(detect, [saved?.profile])
  const status = check !== 'checking' ? check : null

  // A command that doesn't only read asks before it goes on the list; running it asks again, each time.
  const saveCommands = async (): Promise<void> => {
    const next = lines(commands)
    const added = next.filter((l) => !c.commands.includes(l))
    const writes = added.filter((l) => !isReadCommand(commandWords(l)))
    if (writes.length) {
      const ok = await confirmDialog({
        title: L('Liberar comandos que não são só de leitura?', 'Allow commands that do more than read?'),
        body: L(`${writes.join(', ')}. Eles podem mudar coisas no Databricks. Cada uso por um agente pede sua aprovação.`, `${writes.join(', ')}. They can change things on Databricks. Each use by an agent asks for your approval.`),
        confirm: L('Liberar', 'Allow'),
        danger: true
      })
      if (!ok) {
        const safe = next.filter((l) => !writes.includes(l))
        setCommands(safe.join('\n'))
        return set({ commands: safe })
      }
    }
    set({ commands: next })
  }

  return (
    <Card
      title={L('Jobs do Databricks', 'Databricks jobs')}
      lead={L('Como o app acompanha os runs pela CLI do Databricks, com o login que você já tem. Cada agente precisa ter Acompanhar jobs ligado, na aba Ferramentas.', 'How the app follows runs through the Databricks CLI, on the login you already have. Each agent needs Follow jobs on, in its Tools tab.')}
    >
      <div className="key-row">
        <div className="grow">
          <strong>{L('CLI e login', 'CLI and login')}</strong>
          {check === 'checking' && <p className="muted small">{L('Procurando…', 'Looking…')}</p>}
          {status && <p className={`small ${status.ok ? 'job-settings__ok' : 'job-settings__bad'}`}>{status.text}</p>}
          {status?.cliPath && <p className="muted small job-settings__path">{status.cliPath}</p>}
          {status && !status.ok && <p className="muted small">{L('Instale a CLI do Databricks e rode databricks auth login. O app acha os dois sozinho.', 'Install the Databricks CLI and run databricks auth login. The app finds both on its own.')}</p>}
        </div>
        <button className="btn btn--sm" onClick={detect}>
          {L('Procurar de novo', 'Look again')}
        </button>
      </div>
      <Field label={L('Perfil', 'Profile')} hint={L('O app escolhe sozinho. Prefira um perfil só de leitura: é o Databricks que garante isso, não o app.', 'The app picks on its own. Prefer a read-only profile: Databricks is what enforces that, not the app.')}>
        <select value={saved?.profile ?? ''} onChange={(e) => set({ profile: e.target.value })}>
          <option value="">{status?.profile && !saved?.profile ? L(`Automático (${status.profile})`, `Automatic (${status.profile})`) : L('Automático', 'Automatic')}</option>
          {[...(status?.profiles.map((p) => p.name) ?? []), ...(saved?.profile ? [saved.profile] : [])]
            .filter((n, i, all) => all.indexOf(n) === i)
            .map((n) => {
              const p = status?.profiles.find((x) => x.name === n)
              return (
                <option key={n} value={n}>
                  {[n, p?.host, p?.valid === false ? L('sem login', 'not signed in') : ''].filter(Boolean).join(' · ')}
                </option>
              )
            })}
        </select>
      </Field>
      <details className="job-settings__more">
        <summary>{L('A CLI está em outro lugar', 'The CLI is somewhere else')}</summary>
        <Field label={L('Caminho da CLI', 'CLI path')} hint={L('Só se o app não achar sozinho.', 'Only if the app can’t find it on its own.')}>
          <input value={saved?.cliPath ?? ''} placeholder={status?.cliPath ?? 'databricks'} spellCheck={false} onChange={(e) => set({ cliPath: e.target.value })} onBlur={detect} />
        </Field>
      </details>

      <Field label={L('Comandos permitidos', 'Allowed commands')} hint={L('Um por linha, com as opções que ele pode usar. O que não estiver aqui é bloqueado.', 'One per line, with the flags it may use. What isn’t here is blocked.')}>
        <textarea rows={7} value={commands} spellCheck={false} onChange={(e) => setCommands(e.target.value)} onBlur={() => void saveCommands()} />
      </Field>
      <Field label={L('Caminhos do api get', 'api get paths')} hint={L('Um por linha. Escrever pela API (api post e afins) nunca é permitido.', 'One per line. Writing through the API (api post and the like) is never allowed.')}>
        <textarea rows={2} value={paths} spellCheck={false} onChange={(e) => setPaths(e.target.value)} onBlur={() => set({ apiPaths: lines(paths) })} />
      </Field>
      <Field label={L('Endereço da API do Spark', 'Spark API address')} hint={L('Vazio: o app descobre sozinho. Preencha só se ele não achar, com {cluster} no lugar do id do cluster. O caminho precisa estar na lista acima.', 'Empty: the app finds it on its own. Fill it in only if it can’t, with {cluster} for the cluster’s id. The path must be on the list above.')}>
        <input value={saved?.sparkApiBase ?? ''} placeholder="/driver-proxy-api/o/<org>/{cluster}/<port>/api/v1" spellCheck={false} onChange={(e) => set({ sparkApiBase: e.target.value })} />
      </Field>

      <div className="key-row">
        <div className="grow">
          <strong>{L('Ações no job', 'Job actions')}</strong>
          <p className="muted small">{L('Iniciar e cancelar runs. Desligado, nenhum agente pede isso. Ligado, cada uso pede sua aprovação.', 'Starting and canceling runs. Off, no agent asks for it. On, each use asks for your approval.')}</p>
        </div>
        <Toggle
          on={c.actions}
          onChange={(v) => {
            if (!v) return set({ actions: false })
            void confirmDialog({
              title: L('Ligar as ações no job?', 'Turn job actions on?'),
              body: L('Agentes com Acompanhar jobs poderão pedir pra iniciar e cancelar runs, sempre com a sua aprovação.', 'Agents with Follow jobs can ask to start and cancel runs, always with your approval.'),
              confirm: L('Ligar', 'Turn on')
            }).then((ok) => ok && set({ actions: true }))
          }}
        />
      </div>

      <div className="grid2">
        <Field label={L('Intervalo entre consultas (segundos)', 'Time between checks (seconds)')}>
          <NumberInput min={15} value={c.intervalSeconds} onChange={(n) => set({ intervalSeconds: Math.max(15, Math.round(n)) })} />
        </Field>
        <Field label={L('Jobs ao mesmo tempo', 'Jobs at once')}>
          <NumberInput min={1} value={c.maxActive} onChange={(n) => set({ maxActive: Math.max(1, Math.round(n)) })} />
        </Field>
        <Field label={L('Tempo máximo de acompanhamento (horas)', 'Longest time following (hours)')}>
          <NumberInput min={1} value={c.maxHours} onChange={(n) => set({ maxHours: Math.max(1, n) })} />
        </Field>
        <Field label={L('Vezes que o agente acorda por run', 'Times the agent wakes per run')} hint={L('A última fica reservada para o resultado final.', 'The last one is kept for the final result.')}>
          <NumberInput min={1} value={c.maxWakes} onChange={(n) => set({ maxWakes: Math.max(1, Math.round(n)) })} />
        </Field>
        <Field label={L('Considerar sem avanço após (minutos)', 'Treat as no progress after (minutes)')}>
          <NumberInput min={1} value={c.stallMinutes} onChange={(n) => set({ stallMinutes: Math.max(1, n) })} />
        </Field>
        <Field label={L('Task atrasada: vezes a mediana', 'Straggler task: times the median')}>
          <NumberInput min={2} step={0.5} value={c.stragglerFactor} onChange={(n) => set({ stragglerFactor: Math.max(2, n) })} />
        </Field>
        <Field label={L('Lentidão: vezes a mediana dos runs', 'Slow run: times the runs’ median')}>
          <NumberInput min={1.5} step={0.5} value={c.slowFactor} onChange={(n) => set({ slowFactor: Math.max(1.5, n) })} />
        </Field>
        <Field label={L('Limite de spill (GB)', 'Spill limit (GB)')}>
          <NumberInput min={1} value={c.spillLimitGb} onChange={(n) => set({ spillLimitGb: Math.max(1, n) })} />
        </Field>
        <Field label={L('Ao passar do limite de spill', 'When spill passes the limit')}>
          <select value={c.spillAction} onChange={(e) => set({ spillAction: e.target.value === 'wake' ? 'wake' : 'card' })}>
            <option value="card">{L('Só aviso no cartão', 'Only a notice on the card')}</option>
            <option value="wake">{L('Acordar o agente', 'Wake the agent')}</option>
          </select>
        </Field>
      </div>
      <div className="row">
        <button
          className="btn btn--sm btn--ghost"
          onClick={() => {
            setCommands(JOB_WATCH_DEFAULTS.commands.join('\n'))
            setPaths(JOB_WATCH_DEFAULTS.apiPaths.join('\n'))
            set({ commands: JOB_WATCH_DEFAULTS.commands, apiPaths: JOB_WATCH_DEFAULTS.apiPaths })
          }}
        >
          {L('Voltar a lista padrão', 'Restore the default list')}
        </button>
      </div>
    </Card>
  )
}
