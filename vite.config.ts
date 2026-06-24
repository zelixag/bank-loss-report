import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: '/bank-loss-report/',
  plugins: [vue()],
  server: {
    port: 3002,
    open: true,
  },
})
