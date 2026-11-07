// The guided first run's rules: which AI is ready, the models picked behind the scenes, the goals
// and the agent each one starts, the missions and the sidebar they grow (new installs only), the
// tour's marks, and someone invited getting their own welcome.
import { afterEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import { agentModel, aiState, backgroundModel, freshParts, GOAL_IDS, goalById, goalForText, goalFromText, GOALS, MISSIONS, missionsDone, needsSignIn, partShows, shortSidebar, tourCount, tourOn, type MissionFacts } from '../src/shared/onboarding'
import { ENGINE_IDS, type EngineId, type EngineStatus, type Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { initializeWorkspace } from '../src/core/seed'
import { People } from '../src/core/people'

afterEach(() => setLang('pt'))

const none = (): Record<EngineId, EngineStatus> => Object.fromEntries(ENGINE_IDS.map((e) => [e, { installed: false, loggedIn: false }])) as Record<EngineId, EngineStatus>
const with_ = (p: Partial<Record<EngineId, EngineStatus>>): Record<EngineId, EngineStatus> => ({ ...none(), ...p })
const plan = (account = 'Plano'): EngineStatus => ({ installed: true, loggedIn: true, route: 'plan', account })

describe('which AI is ready', () => {
  it('is still being checked, then none, then ready', () => {
    const checking = Object.fromEntries(ENGINE_IDS.map((e) => [e, { installed: false, loggedIn: false, checking: true }])) as Record<EngineId, EngineStatus>
    expect(aiState(checking)).toBe('checking')
    expect(aiState(none())).toBe('none')
    expect(aiState(with_({ codex: plan() }))).toBe('ready')
    // Ready wins over a check still running for the others.
    expect(aiState({ ...checking, claude: plan() })).toBe('ready')
  })

  it("doesn't count a harness turned off or not run yet", () => {
    expect(aiState(with_({ claude: { ...plan(), off: true } }))).toBe('none')
    expect(aiState(with_({ cursor: { ...plan(), soon: true } }))).toBe('none')
  })

  it('offers a sign-in for what is installed and signed out (Codex runs on a login of its own)', () => {
    expect(needsSignIn(with_({ codex: { installed: true, loggedIn: false }, claude: plan() }))).toEqual(['codex'])
    expect(needsSignIn(with_({ opencode: { installed: true, loggedIn: false } }))).toEqual([])
  })
})

describe('the models behind the scenes and the agent’s', () => {
  it("picks Claude's quick one on a plan, then Codex's, then a provider's fastest listed", () => {
    expect(backgroundModel(with_({ claude: plan(), codex: plan() }))).toBe('haiku')
    expect(backgroundModel(with_({ codex: plan() }), { codex: ['gpt-5.6-sol', 'gpt-5.6-luna'] })).toBe('gpt-5.6-luna')
    expect(backgroundModel(with_({ codex: plan() }), { codex: ['gpt-6', 'gpt-6-mini'] })).toBe('codex:gpt-6-mini')
    expect(backgroundModel(with_({ codex: plan() }))).toBe('gpt-5.6-luna')
    expect(backgroundModel(with_({ opencode: { installed: true, loggedIn: true, route: 'providers' } }), { opencode: ['openai/gpt-5.5', 'google/gemini-3-flash'] })).toBe('opencode:google/gemini-3-flash')
  })

  it('leaves it to the person on a gateway, which names its own models', () => {
    expect(backgroundModel(with_({ claude: { ...plan(), route: 'gateway', gateway: 'gw.example.com' } }))).toBeUndefined()
    expect(backgroundModel(none())).toBeUndefined()
  })

  it("gives the agent the everyday model of what's ready", () => {
    expect(agentModel(with_({ claude: plan() }))).toBe('sonnet')
    expect(agentModel(with_({ codex: plan() }))).toBe('gpt-5.6-luna')
    expect(agentModel(with_({ pi: { installed: true, loggedIn: true, route: 'providers' } }), { pi: ['anthropic/claude-x'] })).toBe('pi:anthropic/claude-x')
    expect(agentModel(none())).toBeUndefined()
  })
})

describe('the goals', () => {
  it('has the six tiles, in both languages, each a whole agent with no jargon', () => {
    for (const l of ['pt', 'en'] as const) {
      setLang(l)
      const goals = GOALS()
      expect(goals.map((g) => g.id)).toEqual([...GOAL_IDS])
      for (const g of goals) {
        expect(g.name.length).toBeGreaterThanOrEqual(2)
        expect(g.title && g.role && g.tagline && g.instructions && g.task).toBeTruthy()
        expect(g.does).toHaveLength(3)
        expect(`${g.title} ${g.tagline} ${g.does.join(' ')} ${g.connector?.label ?? ''}`).not.toMatch(/\b(MCP|harness|roteamento|routing)\b/i)
      }
    }
    setLang('pt')
    expect(GOALS()[0]!.title).toBe('Organizar minha semana')
    setLang('en')
    expect(GOALS()[0]!.title).toBe('Organize my week')
  })

  it('turns on the web only where the goal needs it, and offers a connector that exists', () => {
    expect(goalById('research')!.web).toBe(true)
    expect(goalById('customers')!.web).toBe(false)
    expect(goalById('sheets')!.web).toBe(false)
    expect(goalById('week')!.connector?.id).toBe('google-calendar')
    expect(goalById('research')!.connector).toBeUndefined()
  })

  it("matches the person's own words to a goal, accents and all", () => {
    expect(goalFromText('responder clientes da minha loja no Instagram')).toBe('customers')
    expect(goalFromText('Quero organizar minha agenda e os prazos')).toBe('week')
    expect(goalFromText('resumir as notícias do meu setor')).toBe('research')
    expect(goalFromText('escrever posts pro LinkedIn')).toBe('write')
    expect(goalFromText('cuidar do orçamento na planilha')).toBe('sheets')
    expect(goalFromText('arrumar um bug no meu site')).toBe('code')
    expect(goalFromText('help me reply to customers of my shop')).toBe('customers')
    expect(goalFromText('xyz')).toBeUndefined()
  })

  it('builds the agent from those words: what they said goes to what it knows and to its first message', () => {
    const g = goalForText('responder clientes da minha loja no Instagram.')
    expect(g.id).toBe('customers')
    expect(g.instructions).toContain('"responder clientes da minha loja no Instagram."')
    expect(g.task).toBe('responder clientes da minha loja no Instagram. Antes de começar, me pergunta o que precisar.')
    const own = goalForText('Cuidar das plantas do escritório')
    expect(own.id).toBe('own')
    expect(own.name).toBeTruthy()
    expect(own.task.startsWith('cuidar das plantas do escritório.')).toBe(true)
  })
})

const facts = (f: Partial<MissionFacts> = {}): MissionFacts => ({ replied: false, decided: false, connectors: 0, agents: 1, routines: 0, memories: 0, ...f })

describe('the missions', () => {
  it('are the six, each checking itself off from what happened', () => {
    expect(MISSIONS().map((m) => m.id)).toEqual(['talk', 'approve', 'connect', 'second', 'auto', 'remember'])
    expect([...missionsDone(facts())]).toEqual([])
    expect([...missionsDone(facts({ replied: true, decided: true, connectors: 1, agents: 2, routines: 1, memories: 1 }))]).toHaveLength(6)
    expect(missionsDone(facts({ agents: 2 })).has('second')).toBe(true)
    expect(missionsDone(facts({ memories: 1 })).has('remember')).toBe(true)
  })

  it('grow the short sidebar: a part shows once its mission is done, or once it has something in it', () => {
    const fresh: Settings['onboarding'] = { done: true, fresh: true }
    expect(shortSidebar(fresh)).toBe(true)
    expect(partShows('connectors', fresh, missionsDone(facts()))).toBe(false)
    expect(partShows('connectors', fresh, missionsDone(facts({ connectors: 1 })))).toBe(true)
    expect(partShows('routines', fresh, missionsDone(facts()), { routines: true })).toBe(true)
    expect(partShows('wiki', fresh, missionsDone(facts({ memories: 2 })))).toBe(true)
    expect(partShows('channels', fresh, missionsDone(facts({ agents: 2 })))).toBe(true)
    expect(partShows('usage', fresh, missionsDone(facts({ replied: true })))).toBe(true)
  })

  it('tag what they just brought until it is opened', () => {
    const done = missionsDone(facts({ connectors: 1 }))
    expect(freshParts({ done: true, fresh: true }, done)).toEqual(['connectors'])
    expect(freshParts({ done: true, fresh: true, seen: ['connectors'] }, done)).toEqual([])
  })

  it('never shorten the sidebar of an install that had one, nor after "Mostrar tudo de uma vez"', () => {
    for (const o of [undefined, { done: true }, { done: true, checklistHidden: true }, { done: true, fresh: true, showAll: true }] as Settings['onboarding'][]) {
      expect(shortSidebar(o)).toBe(false)
      for (const part of ['memory', 'wiki', 'routines', 'skills', 'report', 'usage', 'connectors', 'channels'] as const) expect(partShows(part, o, new Set())).toBe(true)
      expect(freshParts(o, missionsDone(facts({ connectors: 1 })))).toEqual([])
    }
  })
})

describe('a new install, an existing one, and a workspace made from the switcher', () => {
  const defaults = { workspaceName: 'Eu', context: '', routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1, approvalTtlHours: 1, theme: 'system', language: 'pt' } as Omit<Settings, 'engines'>

  it('marks only a new install for the short sidebar', () => {
    const fresh = new Db(':memory:')
    initializeWorkspace(fresh, {})
    expect(fresh.getSettings(defaults).onboarding).toEqual({ done: false, fresh: true })
    const switcher = new Db(':memory:')
    initializeWorkspace(switcher, { TUCANO_DEFAULT_WORKSPACE: '0' })
    expect(switcher.getSettings(defaults).onboarding).toEqual({ done: false })
  })

  it('leaves an existing install alone: no introduction, no short sidebar', () => {
    const file = new Db(':memory:')
    file.setSettings({ onboarding: { done: true } })
    const again = file.getSettings(defaults).onboarding
    expect(again).toEqual({ done: true })
    expect(shortSidebar(again)).toBe(false)
  })
})

describe('the tour', () => {
  it('shows each mark once, unless the whole tour was skipped', () => {
    expect(tourOn(undefined, 'first')).toBe(false)
    expect(tourOn({ done: true }, 'ask')).toBe(false) // before the introduction ended, or an install from before
    expect(tourOn({ done: true, tour: {} }, 'ask')).toBe(true)
    expect(tourOn({ done: true, tour: { done: ['ask'] } }, 'ask')).toBe(false)
    expect(tourOn({ done: true, tour: { skipped: true } }, 'tuca')).toBe(false)
  })

  it('numbers the marks after the first message as they come', () => {
    expect(tourCount({ done: true, tour: { done: ['first'] } }, true)).toEqual({ at: 1, of: 3 })
    expect(tourCount({ done: true, tour: { done: ['first', 'tuca'] } }, true)).toEqual({ at: 2, of: 3 })
    expect(tourCount({ done: true, tour: { done: ['first'] } }, false)).toEqual({ at: 1, of: 2 })
  })
})

describe('someone invited', () => {
  it('gets their own welcome, with who invited them; someone coming back does not', () => {
    const db = new Db(':memory:')
    const people = new People(db)
    db.renamePerson(db.ownerId(), 'Eduardo', false)
    const owner = db.owner()
    const r = people.join(people.createInvite(owner, { role: 'member' }).code, 'Marina')
    if (!('person' in r)) throw new Error(r.error)
    const s = people.settingsFor(r.person, { ...defaultsFor(), onboarding: { done: false, fresh: true } } as Settings)
    expect(s.onboarding).toEqual({ done: true, guest: { by: 'Eduardo' } })
    // In: the plain done, and the tour starts at the first request.
    people.takePrefs(r.person, { onboarding: { done: true, tour: { done: ['first'] } } })
    expect(people.settingsFor(r.person, defaultsFor() as Settings).onboarding).toEqual({ done: true, tour: { done: ['first'] } })
    // The owner never gets it.
    expect(people.settingsFor(owner, { ...defaultsFor(), onboarding: { done: true } } as Settings).onboarding).toEqual({ done: true })
  })
})

const defaultsFor = (): Omit<Settings, 'engines'> => ({ workspaceName: 'Eduardo', context: '', routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1, approvalTtlHours: 1, theme: 'system', language: 'pt' }) as Omit<Settings, 'engines'>
