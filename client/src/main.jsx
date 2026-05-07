// Sentry init must run before App so React errors are captured.
import { Sentry } from './sentry'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { AuthProvider } from './context/AuthContext'
import './index.css'
import App from './App.jsx'

// Friendly fallback shown if a render error escapes a per-page boundary.
function ErrorScreen({ error, resetError }) {
  return (
    <div style={{ padding: 32, fontFamily: 'sans-serif', color: '#7f1d1d' }}>
      <h2 style={{ marginBottom: 8 }}>Something went wrong</h2>
      <p style={{ color: '#374151', marginBottom: 16 }}>
        The error has been reported. You can refresh or try again.
      </p>
      <pre style={{ background: '#fef2f2', padding: 12, borderRadius: 6, overflow: 'auto' }}>
        {error?.message || String(error)}
      </pre>
      <button onClick={resetError} style={{ marginTop: 12, padding: '8px 14px', background: '#dc2626', color: 'white', border: 0, borderRadius: 6, cursor: 'pointer' }}>
        Try again
      </button>
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={ErrorScreen}>
      <BrowserRouter>
        <AuthProvider>
          <App />
          <Toaster position="top-right" />
        </AuthProvider>
      </BrowserRouter>
    </Sentry.ErrorBoundary>
  </StrictMode>,
)
