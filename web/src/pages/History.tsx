import { useEffect, useState, useSyncExternalStore } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { DiffView, HistorySpine } from '@/components/HistorySpine'
import { Markdown } from '@/components/Markdown'
import { forgetPreviews } from '@/components/WikiLink'
import { crumbs, get, pageUrl, post, q, when, type Commit, type LinkMap } from '@/lib/api'
import { useSite } from '@/lib/site'
import { useSplat } from './PageView'

const short = (h: string) => h.slice(0, 7)

function Title({ path, children }: { path: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <Link to={pageUrl(path)} className="text-sm text-muted-foreground hover:text-foreground hover:underline">
        {[...crumbs(path), path.split('/').pop()].join(' › ')}
      </Link>
      <h1 className="mt-1 text-2xl font-bold">{children}</h1>
    </div>
  )
}

// 넓은 화면(xl · 1280px)인지. 판 본문 칸은 이때만 그리고 받는다 — 좁은 화면에서 숨긴 칸이 이력을 열 때마다 판을 받지 않게.
const XL = '(min-width: 1280px)'
function useWide() {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(XL)
      m.addEventListener('change', cb)
      return () => m.removeEventListener('change', cb)
    },
    () => matchMedia(XL).matches,
  )
}

// 넓은 화면(xl)의 이력 화면 오른쪽 칸 : 고른 판의 본문. 처음에는 지금 판을 편다.
// 2026.11.10 : 「이 판 보기」가 판 화면으로 넘어가 판을 훑던 줄기를 잃었다. 판을 견주는 일이라 줄기와 본문을 한 화면에 둔다.
function RevisionPane({ path, rev }: { path: string; rev: string }) {
  const [data, setData] = useState<{ title: string; body: string; links: LinkMap } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    setData(null)
    setError('')
    get<{ title: string; body: string; links: LinkMap }>(`/api/revision?${q(path)}&rev=${rev}`).then(setData, (e) => setError(e.message))
  }, [path, rev])
  return (
    <section className="sticky top-20 max-h-[calc(100svh-6rem)] min-w-0 flex-1 overflow-y-auto rounded-xl border px-6 py-5" aria-label={`${short(rev)} 판 본문`}>
      <p className="mb-4 font-mono text-xs text-muted-foreground">{short(rev)} 판</p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!data && !error && <div className="h-40 animate-pulse rounded-lg bg-muted/60" />}
      {data && (
        <>
          <h2 className="mb-6 text-2xl font-bold tracking-tight">{data.title}</h2>
          <Markdown source={data.body} links={data.links} />
        </>
      )}
    </section>
  )
}

export function History() {
  const path = useSplat()
  const { site, reload } = useSite()
  const nav = useNavigate()
  const [list, setList] = useState<Commit[] | null>(null)
  const [error, setError] = useState('')
  const [viewing, setViewing] = useState('')
  const wide = useWide()

  useEffect(() => {
    setViewing('')
    get<Commit[]>(`/api/history?${q(path)}`).then(setList, (e) => setError(e.message))
  }, [path])
  const shown = viewing || list?.[0]?.hash || ''

  async function revert(c: Commit) {
    if (!confirm(`${when(c.date)} ${c.author} 판으로 되돌릴까요? 되돌린 것도 새 판으로 이력에 남습니다.`)) return
    try {
      await post('/api/page/revert', { path, rev: c.hash })
      forgetPreviews()
      await reload()
      nav(pageUrl(path))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="max-w-4xl xl:max-w-none">
      <Title path={path}>이력</Title>
      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
      {list && !list.length && <p className="text-muted-foreground">이력이 없습니다.</p>}
      {list && list.length > 0 && (
        <div className="flex items-start gap-8">
          <div className="min-w-0 flex-1 xl:max-w-md xl:flex-none">
            <HistorySpine
              path={path}
              list={list}
              onView={(c) => setViewing(c.hash)}
              viewing={shown}
              actions={(c, i) =>
                site?.user && i > 0 ? (
                  <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => revert(c)}>
                    이 판으로 되돌리기
                  </Button>
                ) : null
              }
            />
          </div>
          {wide && shown && <RevisionPane path={path} rev={shown} />}
        </div>
      )}
    </div>
  )
}

export function Revision() {
  const path = useSplat()
  const [params] = useSearchParams()
  const rev = params.get('r') || ''
  const [data, setData] = useState<{ title: string; body: string; links: LinkMap } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    get<{ title: string; body: string; links: LinkMap }>(`/api/revision?${q(path)}&rev=${rev}`).then(setData, (e) => setError(e.message))
  }, [path, rev])
  return (
    <div className="max-w-[72ch]">
      <Title path={path}>
        {data?.title ?? ''} <span className="font-mono text-base font-normal text-muted-foreground">{short(rev)} 판</span>
      </Title>
      {error && <p className="text-destructive">{error}</p>}
      {data && <Markdown source={data.body} links={data.links} />}
    </div>
  )
}

export function Diff() {
  const path = useSplat()
  const [params] = useSearchParams()
  const a = params.get('a') || ''
  const b = params.get('b') || ''
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    get<{ diff: string }>(`/api/diff?${q(path)}&a=${a}&b=${b}`).then((d) => setDiff(d.diff), (e) => setError(e.message))
  }, [path, a, b])
  return (
    <div className="max-w-5xl">
      <Title path={path}>
        바뀐 곳 <span className="font-mono text-base font-normal text-muted-foreground">{a ? `${short(a)} → ` : '처음 → '}{short(b)}</span>
      </Title>
      {error && <p className="text-destructive">{error}</p>}
      {diff !== null && <DiffView diff={diff} />}
    </div>
  )
}
