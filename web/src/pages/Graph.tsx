import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { List, Network, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { GraphCanvas, KIND_LABEL, KIND_VAR, makeView, type Data, type GraphHandle, type Kind } from '@/components/GraphCanvas'
import { KindDot } from '@/components/Marks'
import { get, pageUrl } from '@/lib/api'
import { scopeOf, useSite } from '@/lib/site'
import { cn } from '@/lib/utils'

// 문서 그래프 화면. ?focus=<경로> 면 그 문서 둘레만 본다. 그리기 · 강조는 GraphCanvas 가 맡는다.
// 고른 묶음과 공통 문서만 그린다. 공통을 고르면 위키 전체를 그린다.
export function Graph() {
  const { site } = useSite()
  const bundle = scopeOf(site)
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const focus = params.get('focus') || ''
  const depth = Number(params.get('depth')) === 2 ? 2 : 1
  const [data, setData] = useState<Data | null>(null)
  const [kinds, setKinds] = useState<Set<Kind>>(new Set(['concept', 'manual', 'page']))
  const [query, setQuery] = useState('')
  // 그림 · 목록. 목록은 캔버스를 쓸 수 없는 키보드 · 화면낭독기 사용자와, 링크가 많은 순서로 훑고 싶은 사람을 위한 같은 자료의 다른 모습이다.
  const [mode, setMode] = useState<'map' | 'list'>('map')
  const canvas = useRef<GraphHandle>(null)

  useEffect(() => {
    if (!site) return
    get<Data>(`/api/graph${bundle ? `?b=${encodeURIComponent(bundle)}` : ''}`).then(setData, () => setData({ nodes: [], links: [] }))
  }, [site, bundle])

  const view = useMemo(() => (data ? makeView(data, focus, depth, kinds) : null), [data, focus, depth, kinds])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !view) return new Set<string>()
    return new Set(view.nodes.filter((n) => n.title.toLowerCase().includes(q)).map((n) => n.id))
  }, [query, view])

  function jump(e: React.FormEvent) {
    e.preventDefault()
    const first = view?.nodes.find((n) => matches.has(n.id))
    if (first) canvas.current?.centerOn(first.id)
  }

  const focusTitle = data?.nodes.find((n) => n.id === focus)?.title
  const toggle = (k: Kind) => {
    const next = new Set(kinds)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    setKinds(next)
  }

  return (
    <div className="flex h-[calc(100svh-3.5rem-4rem)] min-h-96 flex-col gap-3">
      {/* 머리 : 무엇의 그래프인지와 그 범위(단계)만. 거르기 · 찾기는 그림 위에 띄운다.
          2026.11.10 : 제목 · 단계 · 종류 · 보는 방식 · 찾기가 한 줄에 감싸여 좁은 화면에서 두세 줄로 늘고, 주인공인 그림이 그만큼 줄었다. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-2xl font-bold">{focusTitle ? `${focusTitle} 둘레` : '문서 그래프'}</h1>
        {focus && (
          <div className="flex items-center gap-1 text-sm" role="group" aria-label="둘레 범위">
            {[1, 2].map((d) => (
              <Button key={d} size="sm" variant={depth === d ? 'secondary' : 'ghost'} aria-pressed={depth === d} onClick={() => setParams({ focus, depth: String(d) })}>
                {d}단계
              </Button>
            ))}
            <Button size="sm" variant="ghost" asChild>
              <Link to="/graph">전체</Link>
            </Button>
          </div>
        )}
        <div className="ml-auto flex gap-0.5 rounded-lg bg-muted/70 p-0.5" role="tablist" aria-label="보는 방식">
          {(
            [
              ['map', '그림', Network],
              ['list', '목록', List],
            ] as const
          ).map(([m, label, Icon]) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground pointer-coarse:h-10 [&_svg]:size-3.5',
                mode === m && 'bg-background font-medium text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08)]',
              )}
            >
              <Icon />
              {label}
            </button>
          ))}
        </div>
      </div>
      {/* 그림 : 넓은 화면은 찾기 · 종류(범례 겸 거르기)를 그림 왼쪽 아래에 띄운다. 왼쪽 위는 고정한 점 카드 · 오른쪽 아래는 확대 단추 자리다.
          2026.11.10 : 처음에는 오른쪽 위였는데, 고정한 점 카드는 제목 길이만큼 넓어져 그림 폭이 600~900px 일 때 겹쳤다.
          좁은 화면과 목록은 띄우면 내용을 가리므로 위에 한 줄로 둔다. */}
      <div className={cn('relative flex min-h-0 flex-1 flex-col gap-2', mode === 'map' && 'sm:block')}>
        <div
          className={cn(
            'flex flex-wrap items-center gap-x-2 gap-y-1.5',
            mode === 'map' && 'sm:absolute sm:bottom-2 sm:left-2 sm:z-10 sm:max-w-[calc(100%-4rem)] sm:rounded-lg sm:border sm:bg-background/90 sm:p-1.5 sm:shadow-xs sm:backdrop-blur',
          )}
        >
          <form onSubmit={jump} className="relative w-full sm:w-52">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="그래프에서 찾기" className="h-8 pl-8" aria-label="그래프에서 찾기" />
          </form>
          <div className="flex items-center gap-0.5" role="group" aria-label="보일 문서 종류">
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <button
                key={k}
                onClick={() => toggle(k)}
                aria-pressed={kinds.has(k)}
                className={cn('flex items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-accent pointer-coarse:py-2', !kinds.has(k) && 'text-muted-foreground line-through')}
              >
                <span className="size-2.5 rounded-full" style={{ background: `var(${KIND_VAR[k]})`, opacity: kinds.has(k) ? 1 : 0.3 }} />
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </div>
        <div className={cn('min-h-0 flex-1 overflow-hidden rounded-xl border sm:h-full', mode === 'list' && 'hidden')}>
          <GraphCanvas ref={canvas} view={view} focus={focus} matches={matches} onOpen={(id) => nav(pageUrl(id))} />
        </div>
        {mode === 'list' && <NodeList view={view} query={query} />}
      </div>
      <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span>
          {view ? `문서 ${view.nodes.length} · 링크 ${view.links.length}` : ''}
          {query && view ? ` · 「${query}」 ${matches.size}` : ''}
        </span>
        {mode === 'map' && <span className="ml-auto">점을 누르면 이웃 강조가 고정됩니다 · 한 번 더 누르면 문서를 엽니다</span>}
      </p>
    </div>
  )
}

// 그래프의 목록 모습 : 링크가 많은 문서부터. 찾기 칸에 친 글자가 있으면 그 문서만 남긴다.
function NodeList({ view, query }: { view: Data | null; query: string }) {
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return [...(view?.nodes ?? [])].filter((n) => !q || n.title.toLowerCase().includes(q)).sort((a, b) => (b.deg || 0) - (a.deg || 0) || a.title.localeCompare(b.title, 'ko'))
  }, [view, query])
  const max = Math.max(1, ...rows.map((n) => n.deg || 0))
  return (
    <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 text-left font-medium">문서</th>
            <th className="w-1/3 px-4 py-2 text-left font-medium">링크</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((n) => (
            <tr key={n.id} className="hover:bg-accent/60">
              <td className="px-4 py-1.5">
                <Link to={pageUrl(n.id)} className="inline-flex items-center gap-2 hover:underline pointer-coarse:py-2">
                  <KindDot kind={n.kind} />
                  {n.title}
                </Link>
              </td>
              <td className="px-4 py-1.5">
                {/* 링크 수 막대 : 숫자만으로는 중심 문서가 눈에 안 띈다 */}
                <span className="flex items-center gap-2">
                  <span className="h-1.5 rounded-full bg-primary/50" style={{ width: `${((n.deg || 0) / max) * 100}%`, minWidth: 2 }} aria-hidden />
                  <span className="text-xs text-muted-foreground tabular-nums">{n.deg || 0}</span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
