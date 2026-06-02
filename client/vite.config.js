import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Mam (2026-06-02): we ship a tiny build-stamp into the bundle so a
// visible badge in the header lets us tell at a glance which build is
// running on a given phone / browser.  Was guessing for hours whether
// the iPhone PWA had picked up the latest cards or was still on the
// cached old bundle — this kills that guesswork.
export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_STAMP__: JSON.stringify(
      // ISO without milliseconds — readable in the badge as "06-02 12:45"
      new Date().toISOString().replace(/[T:Z]/g, ' ').slice(5, 16).trim()
    ),
  },
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:5000'
    }
  }
})
