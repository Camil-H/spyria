import { createRoot } from 'react-dom/client'
import { createApp } from './app/factory.ts'
import './app/styles.css'
import { App } from './app/Shell.tsx'
import { startMockAgent } from './conversation/surface.ts'

const app = createApp()
startMockAgent(app.store, app.conversationDependencies)
createRoot(document.getElementById('root') as HTMLElement).render(<App app={app} />)
