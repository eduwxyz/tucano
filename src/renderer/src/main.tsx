import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'
import { App } from './App'
import { start, useStore } from './store'
import '@fontsource-variable/inter/opsz.css'
import './styles.css'

void start().catch(() => { /* The connection picker remains usable when a saved VPS is offline. */ })

// Switching the language draws everything again, in the new one.
function Root(): ReactNode {
  const language = useStore((s) => s.settings.language)
  return <App key={language} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
