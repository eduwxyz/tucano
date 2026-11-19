// A page shown inside a hub (Conhecimento: Memória · Wiki · Skills; Operação: Rotinas · Boletim · Uso):
// the hub draws the title and the tabs, so the page inside leaves out its own title and lede and keeps
// only its actions (Page and Sheet in Pages.tsx read this).
import { createContext } from 'react'

export const InHub = createContext(false)
