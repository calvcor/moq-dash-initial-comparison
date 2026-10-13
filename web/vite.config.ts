import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'

// Versión instalada de cada reproductor, leída de node_modules al construir, para mostrarla en el dashboard
const installed = (name: string): string => JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), 'utf8')).version

// https://vite.dev/config/
export default defineConfig({
  define: {
    __PLAYER_VERSIONS__: JSON.stringify({ moq_watch: installed('@moq/watch'), dashjs: installed('dashjs') }),
  },
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    port: 5173,
    host: true,
  }
})
