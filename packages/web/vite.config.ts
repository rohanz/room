import { defineConfig } from 'vite'

export default defineConfig({
  optimizeDeps: { exclude: ['@room/shared'] },
  server: { port: 5173, host: true },
})
