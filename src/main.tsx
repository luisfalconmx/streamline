import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { ExtensionProvider } from './extension-state.tsx'
import { StoreProvider } from './store.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <ExtensionProvider>
        <App />
      </ExtensionProvider>
    </StoreProvider>
  </StrictMode>,
)
