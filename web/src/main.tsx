import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { CampaignPage } from './components/CampaignPage.tsx'

// Sin enrutador: la página de campañas es la única otra
const page = window.location.pathname.startsWith('/campaign') ? <CampaignPage /> : <App />

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {page}
  </StrictMode>,
)
