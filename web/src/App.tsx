import { lazy, Suspense, type ReactNode } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router'
import { Layout } from '@/components/Layout'
import { SiteProvider } from '@/lib/site'
import { Login, Signup } from '@/pages/Account'
import { Diff, History, Revision } from '@/pages/History'
import { Changes, Concepts, Home, SearchPage } from '@/pages/Lists'
import { PageView } from '@/pages/PageView'

// 그래프(force-graph) · 편집 · 계정 관리 · 묶음과 권 · 책장 · 책 보기는 따로 받는다. 읽기만 하는 사람이 첫 화면에서 받을 짐을 줄인다.
const Graph = lazy(() => import('@/pages/Graph').then((m) => ({ default: m.Graph })))
const Edit = lazy(() => import('@/pages/Edit').then((m) => ({ default: m.Edit })))
const Account = lazy(() => import('@/pages/Account').then((m) => ({ default: m.Account })))
const Admin = lazy(() => import('@/pages/Account').then((m) => ({ default: m.Admin })))
const Bundles = lazy(() => import('@/pages/Bundles').then((m) => ({ default: m.Bundles })))
const Book = lazy(() => import('@/pages/Book').then((m) => ({ default: m.Book })))
const Shelf = lazy(() => import('@/pages/Shelf').then((m) => ({ default: m.Shelf })))

const later = (el: ReactNode) => <Suspense fallback={<div className="h-40 animate-pulse rounded-lg bg-muted/60" />}>{el}</Suspense>

export default function App() {
  return (
    // 묶음을 주소에서 읽으므로 SiteProvider 는 라우터 안에 둔다.
    <BrowserRouter>
      <SiteProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="w/*" element={<PageView />} />
            <Route path="books" element={later(<Shelf />)} />
            <Route path="book/*" element={later(<Book />)} />
            <Route path="edit/*" element={later(<Edit />)} />
            <Route path="new" element={later(<Edit isNew />)} />
            <Route path="history/*" element={<History />} />
            <Route path="rev/*" element={<Revision />} />
            <Route path="diff/*" element={<Diff />} />
            <Route path="changes" element={<Changes />} />
            <Route path="concepts" element={<Concepts />} />
            <Route path="bundles" element={later(<Bundles />)} />
            <Route path="graph" element={later(<Graph />)} />
            <Route path="search" element={<SearchPage />} />
            <Route path="login" element={<Login />} />
            <Route path="signup" element={<Signup />} />
            <Route path="account" element={later(<Account />)} />
            <Route path="admin" element={later(<Admin />)} />
            <Route path="*" element={<p className="text-muted-foreground">없는 주소입니다.</p>} />
          </Route>
        </Routes>
      </SiteProvider>
    </BrowserRouter>
  )
}
