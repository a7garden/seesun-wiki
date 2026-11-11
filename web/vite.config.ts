import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 개발 중에는 vite(5173)가 화면을, 위키 서버(4500)가 API 를 맡는다.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 위키 그림이 /assets/ 를 쓰므로 화면 파일은 /static/ 에 둔다.
  build: { assetsDir: 'static', chunkSizeWarningLimit: 1000 },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4500',
      '/assets': 'http://127.0.0.1:4500',
      '/mcp': 'http://127.0.0.1:4500',
    },
  },
})
