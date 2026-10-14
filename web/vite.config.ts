import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'

// Versión instalada de cada reproductor, leída de node_modules al construir, para mostrarla en el dashboard
const installed = (name: string): string => JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), 'utf8')).version

// https://vite.dev/config/
export default defineConfig({
  define: {
    // @moq/net y @moq/hang son dependencias de @moq/watch, pero contienen la parte de red y el catálogo: también
    // condicionan las medidas, y pueden cambiar sin que cambie @moq/watch
    __PLAYER_VERSIONS__: JSON.stringify({
      moq_watch: installed('@moq/watch'),
      moq_net: installed('@moq/net'),
      moq_hang: installed('@moq/hang'),
      dashjs: installed('dashjs'),
    }),
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
