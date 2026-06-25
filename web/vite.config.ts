/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Served as bostadskalkyl.html alongside the hub + the other 5 calculators in
  // the Hemma site. Relative base ('./') makes every asset URL relative to the
  // html file, so the build works whether the site is published at the domain
  // root or under a subpath like GitHub Pages' /bostadskalkyl/. assetsDir keeps
  // the hashed bundle namespaced (/bk-assets/) so it stays collision-free at the
  // shared root as more tools migrate.
  base: './',
  build: { assetsDir: 'bk-assets' },
  server: { port: 5174 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
