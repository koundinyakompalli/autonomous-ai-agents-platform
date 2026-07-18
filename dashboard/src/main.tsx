import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.js'

class RootErrorBoundary extends React.Component<React.PropsWithChildren, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[dashboard] Unhandled render error', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main style={{ minHeight: '100vh', padding: 24, background: '#f7f1eb', color: '#2f2a26', fontFamily: 'Segoe UI, sans-serif' }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Cockpit could not render</h1>
        <pre style={{ marginTop: 16, padding: 16, overflow: 'auto', whiteSpace: 'pre-wrap', background: '#fff', border: '1px solid #d8ccc2' }}>
          {this.state.error.message}
        </pre>
        <button type="button" onClick={() => window.location.reload()} style={{ marginTop: 16, padding: '10px 14px', cursor: 'pointer' }}>
          Reload
        </button>
      </main>
    )
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
)
