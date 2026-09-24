import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'

// Belt-and-suspenders: catches errors React's own error boundary CAN'T
// (async code, timers, event handlers) and puts them on screen as plain
// text instead of the page just going blank with no sign of what happened.
// Nothing here is sent anywhere — it only ever shows in this browser.
function showFatalError(label, detail) {
  let box = document.getElementById('fatal-error-box')
  if (!box) {
    box = document.createElement('div')
    box.id = 'fatal-error-box'
    box.style.cssText =
      'max-width:700px;margin:24px auto;padding:16px 20px;' +
      'font-family:ui-monospace,Menlo,monospace;font-size:12px;' +
      'white-space:pre-wrap;word-break:break-word;' +
      'color:#7a1f1f;background:#fdeceb;border:2px solid #c33f36;' +
      'border-radius:12px;position:relative;z-index:99999;'
    document.body.prepend(box)
  }
  const entry = document.createElement('div')
  entry.style.cssText = 'margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #e6b7b3;'
  entry.textContent = `${label}: ${detail}`
  box.prepend(entry)
}

window.addEventListener('error', (event) => {
  showFatalError('Uncaught error', event.error ? (event.error.stack || event.error.message) : event.message)
})
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  showFatalError('Unhandled promise rejection', reason && reason.stack ? reason.stack : String(reason))
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
