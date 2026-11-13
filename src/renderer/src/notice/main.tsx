import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AreaPicker } from './AreaPicker'
import { NoticeWindow } from './Notice'
import '@fontsource-variable/inter/opsz.css'
import '../styles.css' // the app's own: the palette, the type, the buttons and the agents' faces
import './notice.css'

// One page, two windows: the cards over the app, and the rectangle the person draws for them
// (Settings › Notifications › Where).
const picking = new URLSearchParams(location.search).has('pick')

createRoot(document.getElementById('root')!).render(<StrictMode>{picking ? <AreaPicker /> : <NoticeWindow />}</StrictMode>)
