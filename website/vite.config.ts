import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    // A static site: every page is prerendered to HTML at build time.
    tanstackStart({ prerender: { enabled: true, crawlLinks: true } }),
    viteReact(),
  ],
})
