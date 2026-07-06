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
      // Use 127.0.0.1, NOT "localhost": on Node 17+ "localhost" resolves to IPv6
      // ::1 first, but the API server binds IPv4 only -> "connect ECONNREFUSED
      // ::1:5000", which vite surfaces as a 500 on every proxied login in dev.
      '/api': 'http://127.0.0.1:5000',
      '/socket.io': { target: 'http://127.0.0.1:5000', ws: true }
    }
  }
})
