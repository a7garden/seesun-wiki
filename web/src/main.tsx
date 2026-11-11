import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { ThemeProvider } from 'next-themes'
import App from './App.tsx'

// 밝게 · 어둡게 · 시스템(운영체제 설정) 중 고른 것을 브라우저에 기억한다. 기본은 시스템.
// next-themes 가 그리기 전에 <html> 에 .dark 를 달아 주므로 처음 열 때 흰 화면이 번쩍이지 않는다.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey="wiki-theme">
      <App />
    </ThemeProvider>
  </StrictMode>,
)
