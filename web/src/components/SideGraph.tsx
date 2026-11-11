import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { ArrowDownLeft, ArrowUpRight, Expand } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { GraphCanvas, idOf, makeView, type Data, type GNode } from '@/components/GraphCanvas'
import { dupTitles, KindDot } from '@/components/Marks'
import { get, pageUrl } from '@/lib/api'
import { cn } from '@/lib/utils'

// 곁 칸의 「그래프」 탭 : 위는 이웃 그림, 아래는 이웃 지도(목록).
// 2026.11.09 : 그림(캔버스)만으로는 키보드 · 화면낭독기로 이웃을 알 수 없었다. 같은 내용을 목록으로도 두고,
//              목록에서 가리키거나 초점을 옮기면 그림의 같은 점이 밝아진다 — 목록이 그림을 읽는 손잡이가 된다.
// force-graph 가 커서 문서 화면을 처음 열 때 받지 않도록 이 파일은 SidePanel 이 필요할 때 따로 받는다.

// 그래프 자료는 문서마다 다시 받지 않는다. 다만 문서를 고치면 링크가 바뀌므로 1분 지나면 새로 받는다.
let cache: { at: number; data: Promise<Data> } | null = null
function graphData() {
  if (!cache || Date.now() - cache.at > 60_000) cache = { at: Date.now(), data: get<Data>('/api/graph').catch(() => ({ nodes: [], links: [] })) }
  return cache.data
}

function NeighborGroup({ title, icon, nodes, onHover }: { title: string; icon: React.ReactNode; nodes: GNode[]; onHover: (id: string | null) => void }) {
  const dup = dupTitles(nodes)
  return (
    <section>
      <h3 className="flex items-center gap-1.5 px-3 pt-2.5 pb-1 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {title} <span className="tabular-nums">{nodes.length}</span>
      </h3>
      {nodes.length ? (
        <ul className="px-1.5 pb-1">
          {nodes.map((n) => (
            <li key={n.id}>
              <Link
                to={pageUrl(n.id)}
                onMouseEnter={() => onHover(n.id)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(n.id)}
                onBlur={() => onHover(null)}
                className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-accent pointer-coarse:py-2.5"
              >
                <KindDot kind={n.kind} />
                <span className="truncate">{n.title}</span>
                {dup(n.title) && <span className="shrink-0 text-xs text-muted-foreground">{n.id.split('/')[0]}</span>}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3 pb-2 text-xs text-muted-foreground">없음</p>
      )}
    </section>
  )
}

export default function SideGraph({ path, onClose }: { path: string; onClose: () => void }) {
  const nav = useNavigate()
  const [data, setData] = useState<Data | null>(null)
  const [depth, setDepth] = useState<1 | 2>(1)
  const [hot, setHot] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    graphData().then((d) => live && setData(d))
    return () => {
      live = false
    }
  }, [])

  const view = useMemo(() => (data ? makeView(data, path, depth) : null), [data, path, depth])

  // 이 문서가 가리키는 문서 · 이 문서를 가리키는 문서. 서로 가리키면 둘 다에 나온다.
  const { out, inn } = useMemo(() => {
    const byId = new Map(data?.nodes.map((n) => [n.id, n]) ?? [])
    const out: GNode[] = []
    const inn: GNode[] = []
    for (const l of data?.links ?? []) {
      const a = idOf(l.source), b = idOf(l.target)
      if (a === path && byId.has(b)) out.push(byId.get(b)!)
      if (b === path && byId.has(a)) inn.push(byId.get(a)!)
    }
    const sort = (xs: GNode[]) => xs.sort((x, y) => x.title.localeCompare(y.title, 'ko'))
    return { out: sort(out), inn: sort(inn) }
  }, [data, path])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        {([1, 2] as const).map((d) => (
          <Button key={d} size="xs" variant={depth === d ? 'secondary' : 'ghost'} onClick={() => setDepth(d)} aria-pressed={depth === d}>
            {d}단계
          </Button>
        ))}
        <Button size="xs" variant="ghost" className="ml-auto" asChild>
          <Link to={`/graph?focus=${encodeURIComponent(path)}&depth=${depth}`} onClick={onClose}>
            <Expand />
            크게 보기
          </Link>
        </Button>
      </div>
      <div className="relative min-h-44 flex-[1.15] border-b">
        <GraphCanvas compact view={view} focus={path} highlight={hot} onOpen={(id) => nav(pageUrl(id))} />
        <p className="pointer-events-none absolute bottom-1.5 left-3 text-[11px] text-muted-foreground">
          {view ? `문서 ${view.nodes.length} · 링크 ${view.links.length}` : ''}
        </p>
      </div>
      <nav aria-label="이웃 문서" className={cn('min-h-0 flex-1 overflow-y-auto', !data && 'animate-pulse')}>
        <NeighborGroup title="이 문서가 가리킴" icon={<ArrowUpRight />} nodes={out} onHover={setHot} />
        <NeighborGroup title="이 문서를 가리킴" icon={<ArrowDownLeft />} nodes={inn} onHover={setHot} />
      </nav>
    </div>
  )
}
