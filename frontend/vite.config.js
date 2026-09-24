import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import path from 'path'

// A plain Vite + React setup — no Base44 plugin, no hosted backend
// dependency. This app talks only to your own local API (see src/pages/AuditPage.jsx).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
  },
})
