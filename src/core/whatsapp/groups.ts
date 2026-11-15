// WhatsApp groups for agents, on a number linked by QR code. Listing who is in a group an agent may read
// runs at once; creating a group, adding or removing people and making the invite link are risky, so
// each one waits for a person's approval (marked high risk), needs the admin to have named the agent,
// and is limited per day and per action. The approval is checked again at the moment it runs.
import { L } from '../../shared/lang'
import { UserError } from '../../shared/errors'
import { accessFor, dayStart, GROUP_ACTIONS_PER_DAY, GROUP_PEOPLE_PER_ACTION, phoneDigits, type WhatsAppChat } from '../../shared/whatsapp'
import type { Host, ToolOutcome } from './agent'
import { driverOf, type Shared } from './extras'
import { jidPhone, type QrDriver } from './qr'
import { groupAdd, groupCreate, groupInvite, groupPeople, groupRemove } from './qr-actions'
import type { NumberRow } from './store'
import { GROUP_ACTIONS, listOf, pick, str, type GroupAction } from './tools'

const NAME_LIMIT = 100 // WhatsApp's own limit for a group's name

interface Person {
  id: string // as WhatsApp knows them (phone@s.whatsapp.net)
  nome: string
}

export class Groups {
  constructor(
    private h: Host,
    private s: Shared
  ) {}

  // The administrator must have named this agent, and the number's day must have room.
  private allowed(n: NumberRow, agentId: string): void {
    if (!n.settings.groupManagers.includes(agentId)) {
      throw new UserError(L('Você não tem permissão para criar ou mudar grupos neste número. Peça a um administrador para ligar "Pode cuidar de grupos" para você em Configurações › WhatsApp.', 'You are not allowed to create or change groups on this number. Ask an admin to turn on "Can manage groups" for you in Settings › WhatsApp.'))
    }
    if (this.h.store().groupActionsToday(n.id, dayStart(Date.now())) >= GROUP_ACTIONS_PER_DAY) {
      throw new UserError(L(`Este número já fez ${GROUP_ACTIONS_PER_DAY} mudanças em grupos hoje, que é o limite. Nada foi feito. Não tente de novo hoje.`, `This number already made ${GROUP_ACTIONS_PER_DAY} group changes today, which is the limit. Nothing was done. Don't try again today.`))
    }
  }

  // A group the agent may read, by name or id.
  private group(n: NumberRow, agentId: string, query: string): WhatsAppChat {
    if (!query) throw new UserError(L('Diga qual grupo (grupo). Veja whatsapp_conversas.', 'Say which group (grupo). See whatsapp_conversas.'))
    return pick(
      this.s.usable(n, agentId).filter((c) => c.kind === 'group'),
      query,
      'chat'
    )
  }

  // Changing a group (adding or removing people, the invite link) takes "read and answer" on it; reading only lets the agent list who is in it.
  private canChange(n: NumberRow, agentId: string, group: WhatsAppChat): void {
    if (accessFor(this.h.store().access(n.id), agentId, group.id)?.level !== 'reply') {
      throw new UserError(L(`Para mudar o grupo "${group.name}", ele precisa estar liberado pra você com "Ler e responder". Peça a um administrador para liberar em Configurações › WhatsApp.`, `To change the group "${group.name}", it must be open to you with "Read and answer". Ask an admin to open it in Settings › WhatsApp.`))
    }
  }

  // The phones the agent wrote, checked to be on WhatsApp, with the name the number already has for each.
  private async people(n: NumberRow, driver: QrDriver, phones: string[]): Promise<Person[]> {
    if (!phones.length) throw new UserError(L('Faltou dizer quem: informe os telefones das pessoas (pessoas), com código do país.', 'Say who: give the people\'s phones (pessoas), with country code.'))
    if (phones.length > GROUP_PEOPLE_PER_ACTION) throw new UserError(L(`São pessoas demais de uma vez: no máximo ${GROUP_PEOPLE_PER_ACTION} por ação. Faça em partes.`, `That is too many people at once: at most ${GROUP_PEOPLE_PER_ACTION} per action. Do it in parts.`))
    const digits = phones.map((p) => phoneDigits(p))
    const bad = phones.filter((_, i) => !digits[i])
    if (bad.length) throw new UserError(L(`Estes telefones não parecem válidos: ${bad.join(', ')}. Use o número com código do país, ex.: 5511900000000.`, `These phones don't look valid: ${bad.join(', ')}. Use the number with country code, e.g. 5511900000000.`))
    const known = this.h.store().chats(n.id)
    const out: Person[] = []
    const missing: string[] = []
    for (const d of [...new Set(digits as string[])]) {
      const jid = await driver.resolvePhone(d)
      if (jid) out.push({ id: jid, nome: known.find((c) => c.phone === d)?.name ?? d })
      else missing.push(d)
    }
    if (missing.length) throw new UserError(L(`Estes números não estão no WhatsApp: ${missing.join(', ')}. Nada foi feito.`, `These numbers aren't on WhatsApp: ${missing.join(', ')}. Nothing was done.`))
    return out
  }

  async call(agentId: string, args: Record<string, unknown>, label: string): Promise<ToolOutcome> {
    const n = this.s.pickNumber(agentId, str(args['numero']))
    const acao = str(args['acao']).toLowerCase()
    if (!(GROUP_ACTIONS as readonly string[]).includes(acao)) throw new UserError(L(`Ação desconhecida: "${acao}". Use uma destas: ${GROUP_ACTIONS.join(', ')}.`, `Unknown action: "${acao}". Use one of: ${GROUP_ACTIONS.join(', ')}.`))
    const action = acao as GroupAction
    const driver = driverOf(this.h, n)
    if (action === 'participantes') {
      const group = this.group(n, agentId, str(args['grupo']))
      const list = await groupPeople(driver, group.id)
      const lines = list.slice(0, 200).map((p) => `- ${p.name ?? p.phone ?? p.id}${p.name && p.phone ? ` (${p.phone})` : ''}${p.admin ? L(' · administrador', ' · admin') : ''}`)
      return { text: L(`Grupo "${group.name}", ${list.length} pessoas:\n${lines.join('\n')}`, `Group "${group.name}", ${list.length} people:\n${lines.join('\n')}`), outside: true, step: { label, detail: `${n.name} · ${group.name}` } }
    }
    this.allowed(n, agentId)
    const nome = str(args['nome'])
    if (action === 'criar' && (!nome || nome.length > NAME_LIMIT)) throw new UserError(L(`Diga o nome do grupo (nome), de até ${NAME_LIMIT} caracteres.`, `Give the group's name (nome), up to ${NAME_LIMIT} characters.`))
    const group = action === 'criar' ? undefined : this.group(n, agentId, str(args['grupo']))
    // Every change but criar needs "read and answer" on its group (participantes returned above).
    if (group) this.canChange(n, agentId, group)
    const people = action === 'convite' ? [] : await this.people(n, driver, listOf(args['pessoas'], GROUP_PEOPLE_PER_ACTION + 5))
    const target = group?.name ?? nome
    const names = people.map((p) => p.nome).join(', ')
    return {
      text: L('Essa ação em grupo espera a aprovação de uma pessoa antes de acontecer. Nada foi feito ainda; você será avisado da decisão.', 'This group action waits for a person to approve it before it happens. Nothing was done yet; you will be told the decision.'),
      step: { label, detail: `${n.name} · ${target}` },
      approval: {
        args: { numero_id: n.id, numero: n.name, acao: action, ...(group ? { grupo_id: group.id, grupo: group.name } : {}), ...(action === 'criar' ? { nome } : {}), ...(people.length ? { pessoas: people } : {}) },
        why: L(`Mudança em grupo do WhatsApp (${action}) pelo número ${n.name}.`, `WhatsApp group change (${action}) from the number ${n.name}.`),
        detail: `${action} · ${target}${names ? `: ${names}` : ''}`,
        highRisk: true
      }
    }
  }

  // The people an approval carries, read defensively (it is stored data), within the per-action limit.
  private peopleOf(v: unknown): Person[] {
    if (!Array.isArray(v)) return []
    const out = v
      .slice(0, GROUP_PEOPLE_PER_ACTION + 1)
      .map((p: unknown) => (p && typeof p === 'object' ? { id: str((p as Record<string, unknown>)['id']), nome: str((p as Record<string, unknown>)['nome']) } : { id: '', nome: '' }))
      .filter((p) => p.id)
    if (out.length > GROUP_PEOPLE_PER_ACTION) throw new UserError(L(`São pessoas demais de uma vez: no máximo ${GROUP_PEOPLE_PER_ACTION} por ação. Nada foi feito.`, `That is too many people at once: at most ${GROUP_PEOPLE_PER_ACTION} per action. Nothing was done.`))
    return out
  }

  // Does what a person approved, after checking it all again: the number, the permission, the day, the access and the connection.
  async approved(agentId: string, args: Record<string, unknown>): Promise<string> {
    const n = this.h.store().number(str(args['numero_id']))
    if (!n) throw new UserError(L('Esse número de WhatsApp não existe mais. Nada foi feito.', 'That WhatsApp number no longer exists. Nothing was done.'))
    const acao = str(args['acao'])
    if (acao !== 'criar' && acao !== 'adicionar' && acao !== 'remover' && acao !== 'convite') throw new UserError(L('Não entendi essa ação de grupo. Nada foi feito.', "I didn't understand that group action. Nothing was done."))
    this.allowed(n, agentId)
    const driver = driverOf(this.h, n)
    const people = this.peopleOf(args['pessoas'])
    const nameOf = (jid: string): string => people.find((p) => p.id === jid)?.nome || jidPhone(jid) || jid
    if (acao === 'criar') {
      const nome = str(args['nome'])
      if (!nome || !people.length) throw new UserError(L('Faltam o nome ou as pessoas do grupo. Nada foi feito.', "The group's name or people are missing. Nothing was done."))
      this.count(n)
      const made = await groupCreate(driver, nome, people.map((p) => p.id))
      this.done(n, agentId, made.id, made.name, people.length + 1)
      return L(`Criei o grupo "${made.name}" com ${people.length} pessoas. Ele já está aberto para você (com aprovação nas respostas).`, `Created the group "${made.name}" with ${people.length} people. It is already open to you (replies with approval).`)
    }
    const id = str(args['grupo_id'])
    const group = this.s.usable(n, agentId).find((c) => c.id === id && c.kind === 'group')
    if (!group) throw new UserError(L('Você não tem mais acesso a esse grupo. Nada foi feito.', 'You no longer have access to that group. Nothing was done.'))
    this.canChange(n, agentId, group)
    if (acao === 'convite') {
      this.count(n)
      const link = await groupInvite(driver, id)
      return L(`O link de convite do grupo "${group.name}": ${link}`, `The invite link of the group "${group.name}": ${link}`)
    }
    if (!people.length) throw new UserError(L('Faltou dizer quem. Nada foi feito.', 'Say who. Nothing was done.'))
    this.count(n)
    const result = await (acao === 'adicionar' ? groupAdd : groupRemove)(driver, id, people.map((p) => p.id))
    const lines = result.map((r) => `${r.ok ? '✓' : '✗'} ${nameOf(r.jid)}${r.reason ? ` — ${r.reason}` : ''}`)
    const did = acao === 'adicionar' ? L('adicionar', 'add') : L('remover', 'remove')
    return L(`Pedi ao WhatsApp para ${did} as pessoas no grupo "${group.name}":\n${lines.join('\n')}`, `Asked WhatsApp to ${did} the people in the group "${group.name}":\n${lines.join('\n')}`)
  }

  // Takes one of the day's slots before the action starts, so calls in parallel can't all pass the check. A group action that
  // fails still keeps its slot: it may have reached WhatsApp, and this is the simplest rule that is also safe.
  private count(n: NumberRow): void {
    try {
      this.h.store().addEvent(n.id, 'group')
    } catch (e) {
      this.h.fail(e) // the action still goes; only its count may be lost
    }
  }

  // A group the agent made is its own: it can read it and answer there (each answer still waits for approval).
  private done(n: NumberRow, agentId: string, id: string, name: string, size: number): void {
    try {
      const store = this.h.store()
      store.upsertChat(n.id, { id, name, kind: 'group', size })
      if (accessFor(store.access(n.id), agentId, id)?.level !== 'reply') store.setSend(n.id, agentId, id, 'reply', 'ask')
      this.h.changed()
    } catch (e) {
      this.h.fail(e) // the group exists; the agent can be given access from the screen
    }
  }

  // The sentence of a decision.
  what(args: Record<string, unknown>): string {
    const number = str(args['numero']) || str(args['numero_id'])
    const people = Array.isArray(args['pessoas']) ? args['pessoas'].length : 0
    const group = str(args['grupo']) || str(args['grupo_id'])
    switch (str(args['acao'])) {
      case 'criar':
        return L(`criar o grupo "${str(args['nome'])}" com ${people} pessoas pelo número ${number}`, `create the group "${str(args['nome'])}" with ${people} people from the number ${number}`)
      case 'adicionar':
        return L(`adicionar ${people} pessoas ao grupo "${group}" pelo número ${number}`, `add ${people} people to the group "${group}" from the number ${number}`)
      case 'remover':
        return L(`remover ${people} pessoas do grupo "${group}" pelo número ${number}`, `remove ${people} people from the group "${group}" from the number ${number}`)
      default:
        return L(`gerar o link de convite do grupo "${group}" pelo número ${number}`, `make the invite link of the group "${group}" from the number ${number}`)
    }
  }
}
