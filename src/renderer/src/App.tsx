import { useEffect, type ReactNode } from 'react'
import { L } from '../../shared/lang'
import { getState, navigate, openDialog, setNav, useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { ConversationView } from './components/Conversation'
import { AgentPage, ApprovalsPage, ConnectorsPage, SettingsPage } from './components/Pages'
import { UsagePage } from './components/Usage'
import { MemoryPage } from './components/Memory'
import { RoutinesPage } from './components/Routines'
import { SkillsPage } from './components/Skills'
import { ReportPage } from './components/Report'
import { Onboarding } from './components/Onboarding'
import { Dialogs } from './components/Dialogs'
import { Icon } from './components/ui'

export function App(): ReactNode {
  const view = useStore((s) => s.view)
  const theme = useStore((s) => s.settings.theme)
  const language = useStore((s) => s.settings.language)
  const intro = useStore((s) => s.ready && s.settings.onboarding?.done === false)
  const mac = useStore((s) => s.platform === 'mac')
  const navOpen = useStore((s) => s.navOpen)

  useEffect(() => {
    document.documentElement.lang = language === 'en' ? 'en' : 'pt-BR'
  }, [language])

  useEffect(() => {
    document.documentElement.dataset['os'] = mac ? 'mac' : 'other'
  }, [mac])

  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset['theme']
    else document.documentElement.dataset['theme'] = theme
  }, [theme])

  // ⌘K go anywhere · ⌘N new channel · ⌘1–9 the channels in order · ⌘, settings (Ctrl off a Mac)
  useEffect(() => {
    const keys = (e: KeyboardEvent): void => {
      const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (!mod || e.altKey || intro) return
      const s = getState()
      const channels = s.conversations.filter((c) => c.kind === 'channel')
      if (e.key === 'k') openDialog(s.dialog?.kind === 'search' ? null : { kind: 'search' })
      else if (e.key === 'n' && !e.shiftKey) openDialog({ kind: 'new-channel' })
      else if (e.key === ',') navigate({ kind: 'settings' })
      else if (/^[1-9]$/.test(e.key) && channels[Number(e.key) - 1]) navigate({ kind: 'conversation', id: channels[Number(e.key) - 1]!.id })
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [intro, mac])

  if (!view) return <div className="boot" />
  // Dialogs too: connecting a tool from the introduction may open one (on a server).
  if (intro)
    return (
      <>
        <Onboarding />
        <Dialogs />
      </>
    )
  if (view.kind === 'tuca')
    return (
      <>
        <Onboarding build from={view.from} />
        <Dialogs />
      </>
    )

  return (
    <div className={`app ${navOpen ? 'is-nav-open' : ''}`}>
      {/* On a phone the sidebar is a drawer: this opens it, the shade closes it. */}
      <button className="mobile-nav" aria-label={L('Abrir o menu', 'Open the menu')} onClick={() => setNav(true)}>
        <Icon name="menu" size={18} />
      </button>
      <div className="nav-shade" onClick={() => setNav(false)} />
      <Sidebar />
      <main className="main">
        {view.kind === 'conversation' && <ConversationView key={view.id} id={view.id} />}
        {view.kind === 'agent' && <AgentPage key={view.id} id={view.id} />}
        {view.kind === 'new-agent' && <AgentPage key={view.fromMessage ?? 'new'} draft={view.draft} fromMessage={view.fromMessage} />}
        {view.kind === 'approvals' && <ApprovalsPage />}
        {view.kind === 'usage' && <UsagePage />}
        {view.kind === 'connectors' && <ConnectorsPage />}
        {view.kind === 'memory' && <MemoryPage />}
        {view.kind === 'routines' && <RoutinesPage />}
        {view.kind === 'skills' && <SkillsPage />}
        {view.kind === 'report' && <ReportPage />}
        {view.kind === 'settings' && <SettingsPage />}
      </main>
      <Dialogs />
    </div>
  )
}
