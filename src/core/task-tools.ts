// The board's tasks seen from the agents' side (`sugerir_tarefa`, `concluir_tarefa`), and the small pieces
// of task logic the handlers in index.ts share: its text, its state moves, a schedule read defensively.
import { randomUUID } from 'node:crypto'
import { L, locale } from '../shared/lang'
import { UserError } from '../shared/errors'
import type { CoreEvent } from '../shared/rpc'
import { MAX_AGENT_SUGGESTIONS, MAX_TASK_NOTES, MAX_TASK_RESULT, MAX_TASK_TITLE, type Agent, type Person, type Routine, type Schedule, type Task, type TaskState } from '../shared/types'
import type { Db } from './db'
import type { ToolDef } from './gateway'
import type { Routines } from './routines'

export const DONE_KEEP_MS = 30 * 86_400_000 // a done task stays on the board this long

export const SUGERIR_TAREFA: ToolDef = {
  name: 'sugerir_tarefa',
  get description() {
    return L(
      'Sugere uma tarefa pra pessoa com quem você está trabalhando, quando você nota algo que vale fazer e ninguém pediu. A tarefa não vai pra lista dela até ela aceitar, e ela pode descartar: não comece esse trabalho agora.',
      'Suggests a task to the person you are working with, when you notice something worth doing that nobody asked for. The task does not go on their list until they accept it, and they may dismiss it: do not start that work now.'
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: {
        titulo: { type: 'string', description: L('O que é pra fazer, numa frase curta.', 'What is to be done, in one short sentence.') },
        detalhes: { type: 'string', description: L('O que quem for fazer precisa saber (contexto, onde olhar).', 'What whoever does it needs to know (context, where to look).') },
        para: { type: 'string', description: L('Quem faria: o @handle ou o nome de outro agente do time. Sem isto, é você.', 'Who would do it: the @handle or name of another agent on the team. Left out, it is you.') }
      },
      required: ['titulo']
    }
  }
}

export const CONCLUIR_TAREFA: ToolDef = {
  name: 'concluir_tarefa',
  get description() {
    return L(
      'Encerra a tarefa do quadro em que esta rotina trabalha, quando ela está de fato feita: a rotina deixa de rodar. Só chame quando terminou; se ainda falta, diga em uma linha em que pé está.',
      'Ends the board task this routine works on, once it is truly done: the routine stops running. Only call it when finished; if something is left, say in one line where it stands.'
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: { resultado: { type: 'string', description: L('O que ficou feito, em poucas linhas: é o que a pessoa lê na tarefa.', 'What got done, in a few lines: it is what the person reads on the task.') } },
      required: ['resultado']
    }
  }
}

export const TASK_TOOL_NAMES = new Set([SUGERIR_TAREFA.name, CONCLUIR_TAREFA.name])

// A task's text as kept: no control characters but newlines, no longer than `max`.
export const cleanTaskText = (s: unknown, max: number): string => (typeof s === 'string' ? s.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, max) : '')
export const cleanTaskTitle = (s: unknown): string => cleanTaskText(s, MAX_TASK_TITLE).replace(/\s+/g, ' ')

// What the agent is told to do: the title, the notes, the due date. Starting a task posts it, and a task a
// routine repeats is that routine's request.
export const taskBody = (t: Pick<Task, 'title' | 'notes' | 'dueAt'>): string =>
  `${t.title}${t.notes ? `\n\n${t.notes}` : ''}${t.dueAt ? `\n\n${L('Prazo', 'Due')}: ${new Date(t.dueAt).toLocaleDateString(locale(), { day: 'numeric', month: 'long' })}` : ''}`

// The line a routine's run reads when the routine works on a board task.
export const routineTaskLine = (title: string): string =>
  L(
    `Esta rotina trabalha na tarefa "${title}" do quadro, até ela terminar. Quando estiver mesmo pronta, chame concluir_tarefa com o resultado; se ainda não, diga em uma linha em que pé ela está.`,
    `This routine works on the board task "${title}" until it is done. When it is really finished, call concluir_tarefa with the result; if not yet, say in one line where it stands.`
  )

// "Revisar o Contrato" and "revisar o contrato" are the same task.
const same = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()

// Where a task goes when a person moves it by hand. `wanted` arrives from outside: only the three states
// are valid, and a suggestion that was not accepted, or a task a routine works on, can't be moved around.
// A task not moved keeps its state; "to do" is stored as no state.
export function taskState(prev: Task | undefined, wanted: unknown, now: number): Pick<Task, 'state' | 'doneAt' | 'result'> {
  if (wanted === undefined) return { ...(prev?.state ? { state: prev.state } : {}), ...(prev?.doneAt ? { doneAt: prev.doneAt } : {}), ...(prev?.result ? { result: prev.result } : {}) }
  if (wanted !== 'todo' && wanted !== 'doing' && wanted !== 'done') throw new UserError(L('Estado de tarefa inválido.', 'Invalid task state.'))
  const was: TaskState = prev?.state ?? 'todo'
  if (prev?.suggestedBy && wanted !== was) throw new UserError(L('Aceite essa sugestão antes de mexer nela.', 'Accept this suggestion before moving it.'))
  if (prev?.routineId && wanted !== 'done' && wanted !== was) throw new UserError(L('Uma rotina trabalha nessa tarefa. Pare de repetir antes de mudar o estado, ou marque como feita.', 'A routine works on this task. Stop repeating before changing its state, or mark it done.'))
  if (wanted === 'done') return { state: 'done', doneAt: was === 'done' && prev?.doneAt ? prev.doneAt : now, ...(was === 'done' && prev?.result ? { result: prev.result } : {}) }
  return wanted === 'doing' ? { state: 'doing' } : {}
}

// A schedule arrives from outside as any object: this keeps what has the right type, and routines.save judges
// the values (a clear message for each). Not an object at all: refused here.
export function cleanSchedule(s: unknown): Schedule {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new UserError(L('Escolha quando repetir.', 'Pick when to repeat.'))
  const o = s as Record<string, unknown>
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  return {
    days: list(o['days']).filter((d): d is number => typeof d === 'number'),
    time: typeof o['time'] === 'string' ? o['time'] : '',
    ...(Array.isArray(o['times']) ? { times: o['times'].filter((t): t is string => typeof t === 'string') } : {}),
    // No `once` or `date`: a task's routine repeats until the task is done, so it is never a one-off.
    ...(typeof o['monthDay'] === 'number' ? { monthDay: o['monthDay'] } : {})
  }
}

// What a person's own to-do list needs from a task being added at its top.
export const topPosition = (tasks: Task[]): number => (tasks.length ? Math.min(...tasks.map((t) => t.position)) - 1 : 0)

type ToolOutcome = { reply: string; error?: boolean; task?: Task }

// `sugerir_tarefa`: an agent leaves a task for the person it works for. `pickable`: the team agents that person sees.
export function suggestTask(db: Db, emit: (e: CoreEvent) => void, agent: Agent, owner: Person, args: Record<string, unknown>, pickable: Agent[], routine?: Routine): ToolOutcome {
  const fail = (reply: string): ToolOutcome => ({ reply, error: true })
  const title = cleanTaskTitle(args['titulo'])
  if (!title) return fail(L('Falta o título da tarefa (titulo).', 'The task title (titulo) is missing.'))
  const para = typeof args['para'] === 'string' ? args['para'].trim().replace(/^@/, '').toLowerCase() : ''
  const doer = para ? pickable.find((a) => a.handle.toLowerCase() === para || a.name.trim().toLowerCase() === para) : agent
  if (!doer) return fail(L(`Não achei "${para}" no time. Quem dá pra escolher: ${pickable.map((a) => `@${a.handle} (${a.name})`).join(', ') || 'ninguém'}.`, `I couldn't find "${para}" on the team. Who can be picked: ${pickable.map((a) => `@${a.handle} (${a.name})`).join(', ') || 'no one'}.`))
  const mine = db.tasks(owner.id)
  const open = mine.filter((t) => t.state !== 'done')
  if (open.some((t) => same(t.title) === same(title)))
    return { reply: L(`Essa tarefa já está lá (na lista ou entre as sugestões): "${title}". Não criei outra.`, `That task is already there (on the list or among the suggestions): "${title}". I did not create another.`) }
  if (mine.filter((t) => t.suggestedBy === agent.id).length >= MAX_AGENT_SUGGESTIONS)
    return fail(L(`Você já tem ${MAX_AGENT_SUGGESTIONS} sugestões esperando ${owner.name} decidir. Espere a resposta antes de sugerir mais.`, `You already have ${MAX_AGENT_SUGGESTIONS} suggestions waiting for ${owner.name} to decide. Wait for the answer before suggesting more.`))
  const notes = cleanTaskText(args['detalhes'], MAX_TASK_NOTES)
  const task: Task = { id: randomUUID(), owner: owner.id, title, position: topPosition(mine), createdAt: Date.now(), agentId: doer.id, suggestedBy: agent.id, ...(notes ? { notes } : {}), ...(routine ? { fromRoutine: routine.name } : {}) }
  db.saveTask(task)
  emit({ type: 'tasks', for: owner.id })
  return {
    task,
    reply: L(
      `Sugeri a tarefa "${title}" (${doer.id === agent.id ? 'pra você' : `pra @${doer.handle}`}). ${owner.name} decide se aceita: não comece esse trabalho agora.`,
      `I suggested the task "${title}" (${doer.id === agent.id ? 'for you' : `for @${doer.handle}`}). ${owner.name} decides whether to accept it: do not start that work now.`
    )
  }
}

// `concluir_tarefa`: from a run of the routine that works on a task, which ends it. `routine`: as it is now (gone: undefined).
// The routine is removed while its own run is still going; Routines never writes back to one that's gone.
export function concludeTask(db: Db, emit: (e: CoreEvent) => void, routines: Pick<Routines, 'remove'>, routine: Routine | undefined, args: Record<string, unknown>, now = Date.now()): ToolOutcome {
  const task = routine?.taskId ? db.task(routine.taskId) : undefined
  if (!routine || !task || task.routineId !== routine.id) return { reply: L('Esta rotina não trabalha mais numa tarefa do quadro.', 'This routine no longer works on a board task.'), error: true }
  const result = cleanTaskText(args['resultado'], MAX_TASK_RESULT)
  if (!result) return { reply: L('Falta o resultado (resultado): diga o que ficou feito.', 'The result (resultado) is missing: say what got done.'), error: true }
  const saved: Task = { ...task, routineId: undefined, state: 'done', doneAt: now, result }
  db.saveTask(saved) // first: removing the routine puts back any task still pointing at it
  routines.remove(routine.id)
  db.pruneDoneTasks(task.owner, now - DONE_KEEP_MS)
  emit({ type: 'tasks', for: task.owner })
  return { task: saved, reply: L(`Tarefa "${task.title}" marcada como feita e a rotina foi encerrada. Não precisa fazer mais nada.`, `Task "${task.title}" marked done and the routine was ended. Nothing more to do.`) }
}
