import { lazy, Suspense, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { History as HistoryIcon, Network, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HistorySpine } from '@/components/HistorySpine'
import { get, pageUrl, q, type Commit } from '@/lib/api'
import { cn } from '@/lib/utils'

// 문서 화면의 오른쪽 칸. 「이력」과 「그래프」를 화면을 넘기지 않고 본문 옆에서 본다.
// 2026.11.09 : 그래프는 오른쪽 아래 떠 있는 작은 칸이었고, 이력은 화면을 넘겼다. 둘을 한 칸의 탭으로 모았다.
// 칸 안에서 다른 문서를 열어도 칸은 남고 그 문서를 기준으로 다시 그린다 — 열고 닫는 상태는 부르는 쪽(PageView)이 쥔다.
export type SideTab = 'history' | 'graph'

// 그래프 탭은 force-graph 를 쓰므로 탭을 처음 열 때 받는다.
const SideGraph = lazy(() => import('@/components/SideGraph'))

const TABS = [
  { value: 'history', label: '이력', icon: HistoryIcon },
  { value: 'graph', label: '그래프', icon: Network },
] as const

function HistoryTab({ path }: { path: string }) {
  const [list, setList] = useState<Commit[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setList(null)
    setError('')
    get<Commit[]>(`/api/history?${q(path)}`).then(setList, (e) => setError(e.message))
  }, [path])

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pt-1">
        {error && <p className="p-3 text-sm text-destructive">{error}</p>}
        {!list && !error && (
          <div className="space-y-4 p-3" aria-label="불러오는 중">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex gap-3">
                <span className="mt-1 size-3 rounded-full bg-muted" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-3/4 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        )}
        {list && !list.length && <p className="p-3 text-sm text-muted-foreground">아직 이력이 없습니다.</p>}
        {list && list.length > 0 && <HistorySpine path={path} list={list} compact />}
      </div>
      {/* 되돌리기는 확인이 필요한 일이라 칸에 두지 않고 이력 화면에만 둔다 */}
      <Link className="border-t px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" to={pageUrl(path, '/history')}>
        이력 화면에서 보기 · 이 판으로 되돌리기 →
      </Link>
    </div>
  )
}

// 넓은 화면(xl)은 본문 옆에 붙박이 칸, 좁은 화면은 오른쪽에서 덮는 칸.
export function SidePanel({ path, tab, onTab, onClose }: { path: string; tab: SideTab; onTab: (t: SideTab) => void; onClose: () => void }) {
  // 그래프 안에서 Esc 로 고정을 풀었으면(defaultPrevented) 칸은 닫지 않는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside
      aria-label="문서 곁 칸"
      className={cn(
        'fixed top-14 right-0 bottom-0 z-40 flex w-full flex-col overflow-hidden border-l bg-background shadow-[-12px_0_32px_-16px_rgb(0_0_0/0.25)] sm:w-[24rem]',
        'xl:sticky xl:top-[5.5rem] xl:bottom-auto xl:z-auto xl:h-[calc(100svh-7rem)] xl:w-[22rem] xl:shrink-0 xl:rounded-xl xl:border xl:shadow-none 2xl:w-[26rem]',
      )}
    >
      <header className="flex items-center gap-2 border-b bg-surface p-1.5">
        <div className="flex flex-1 gap-0.5 rounded-lg bg-muted/70 p-0.5" role="tablist" aria-label="곁 칸 보기">
          {TABS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => onTab(value)}
              className={cn(
                'inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground pointer-coarse:h-10 [&_svg]:size-3.5',
                tab === value && 'bg-background font-medium text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08)]',
              )}
            >
              <Icon />
              {label}
            </button>
          ))}
        </div>
        <Button size="icon-sm" variant="ghost" className="pointer-coarse:size-10" aria-label="곁 칸 닫기 (Esc)" title="닫기 (Esc)" onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className="min-h-0 flex-1" role="tabpanel">
        {tab === 'history' ? (
          <HistoryTab path={path} />
        ) : (
          <Suspense fallback={<div className="m-3 h-48 animate-pulse rounded-lg bg-muted" />}>
            <SideGraph path={path} onClose={onClose} />
          </Suspense>
        )}
      </div>
    </aside>
  )
}
