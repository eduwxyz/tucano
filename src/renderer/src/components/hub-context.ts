// A page shown inside a hub (Conhecimento: Memória · Wiki · Skills; Operação: Rotinas · Boletim · Uso):
// the hub draws the title and the tabs, so the page inside leaves out its own title and lede and keeps
// only its actions (Page and Sheet in Pages.tsx read this).
import { createContext } from 'react'

export const InHub = createContext(false)

// The element at the right of the hub's tab row, above the hairline: a page inside portals its own
// controls there, so a page's toolbar can sit beside the tabs it belongs to instead of in a band of
// its own under them (Wiki.tsx is the first to use it). It is null until the hub has mounted, so a
// page renders its controls in its own head for that first pass.
export const HubTools = createContext<HTMLElement | null>(null)
