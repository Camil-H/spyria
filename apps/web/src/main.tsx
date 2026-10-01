import { createRoot } from 'react-dom/client'
import { createApp } from './app/factory.ts'
import './app/styles.css'
import { App } from './app/Shell.tsx'

createRoot(document.getElementById('root') as HTMLElement).render(<App app={createApp()} />)
