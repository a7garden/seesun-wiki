import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowLeft, ArrowRight, BookOpen, History as HistoryIcon, Network, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SidePanel, type SideTab } from '@/components/SidePanel'
import { Markdown, TocList } from '@/components/Markdown'
import { AuthorMark, dupTitles, KindDot, KindTag } from '@/components/Marks'
import { hasTocMark, tocHeadings } from '@/lib/headings'
import { ago, ApiError, bookUrl, get, pageUrl, q, when, type Brief, type Page } from '@/lib/api'
import { useSite } from '@/lib/site'
import { cn } from '@/lib/utils'

const SIDE_KEY = 'wiki.side'

function loadSide(): SideTab | null {
  try {
    const v = sessionStorage.getItem(SIDE_KEY)
    return v === 'history' || v === 'graph' ? v : null
  } catch {
    return null
  }
}

function saveSide(t: SideTab | null) {
  try {
    if (t) sessionStorage.setItem(SIDE_KEY, t)
    else sessionStorage.removeItem(SIDE_KEY)
  } catch {
    // 저장소를 못 쓰면 이 화면 안에서만 기억한다
  }
}

export function useSplat() {
  return decodeURIComponent(useParams()['*'] || '')
}

// 넓은 화면(xl)은 오른쪽에 붙박이 차례, 좁은 화면은 본문 위에 접는 차례.
// 본문에 「[목차]」가 있으면 그 자리에 차례가 그려지므로 좁은 화면용은 그리지 않는다.
// 곁 칸(이력 · 그래프)이 열리면 오른쪽 자리를 곁 칸에 내주고 넓은 화면에서도 접는 차례를 쓴다 — 셋이 나란히 서면 본문이 너무 좁아진다.
//
// 읽기 진행 차례 : 지금 읽는 절에 표시가 붙고, 차례 옆 선이 읽은 만큼 위에서부터 차오른다.
// 2026.11.09 : 전에는 차례가 글을 내려도 그대로라 긴 매뉴얼에서 어디쯤인지 알 수 없었다.
export function useActiveHeading(ids: string[]) {
  const [active, setActive] = useState(-1)
  useEffect(() => {
    if (!ids.length) return
    let raf = 0
    const measure = () => {
      raf = 0
      // 머리줄(56px) 아래 조금 내려온 선을 지난 마지막 제목이 지금 읽는 절이다.
      const line = 120
      let i = -1
      ids.forEach((id, k) => {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top <= line) i = k
      })
      // 문서 끝까지 내렸으면 마지막 절 — 마지막 절이 짧으면 제목이 기준선에 닿지 못한다.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) i = ids.length - 1
      setActive(i)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    measure()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [ids])
  return active
}

function Toc({ body }: { body: string }) {
  const hs = useMemo(() => tocHeadings(body), [body])
  const ids = useMemo(() => hs.map((h) => h.id), [hs])
  const active = useActiveHeading(ids)
  const items = useRef<(HTMLLIElement | null)[]>([])
  const [fill, setFill] = useState(0)
  useEffect(() => {
    const li = items.current[active]
    setFill(li ? li.offsetTop + li.offsetHeight : 0)
  }, [active, hs])
  if (hs.length < 2) return null
  return (
    <nav className="sticky top-20 hidden max-h-[calc(100svh-6rem)] w-52 shrink-0 overflow-y-auto text-sm xl:block" aria-label="이 문서의 차례">
      <p className="mb-3 text-xs font-medium text-muted-foreground">이 문서에서</p>
      <ul className="relative space-y-0.5 pl-3.5">
        {/* 바탕 선과 읽은 만큼 차오르는 선 */}
        <span className="absolute top-0 bottom-0 left-0 w-px bg-border" aria-hidden />
        <span
          className="absolute top-0 left-0 w-[2px] -translate-x-[0.5px] rounded-full bg-primary transition-[height] duration-300 ease-out motion-reduce:transition-none"
          style={{ height: fill }}
          aria-hidden
        />
        {hs.map((h, i) => (
          <li
            key={h.id}
            ref={(el) => {
              items.current[i] = el
            }}
            className={h.depth === 3 ? 'pl-3' : ''}
          >
            <a
              href={`#${h.id}`}
              aria-current={i === active ? 'location' : undefined}
              className={cn(
                'block py-1 leading-snug transition-colors',
                i === active ? 'font-medium text-foreground' : i < active ? 'text-foreground/60 hover:text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function FoldedToc({ body, always }: { body: string; always?: boolean }) {
  const n = useMemo(() => tocHeadings(body).length, [body])
  if (n < 2 || hasTocMark(body)) return null
  return (
    <details className={`mb-8 rounded-lg border bg-surface px-4 text-sm ${always ? '' : 'xl:hidden'}`}>
      <summary className="-mx-4 cursor-pointer px-4 py-3 font-medium text-muted-foreground">
        차례 <span className="font-normal">· 절 {n}개</span>
      </summary>
      <div className="mb-3">
        <TocList body={body} />
      </div>
    </details>
  )
}

// 이전 · 다음은 그 권 안에서만 넘긴다.
// 2026.11.10 : 전에는 모든 권을 한 줄로 이어 셈해, 권의 마지막 장에서 「다음」이 다른 권(공유 묶음의 권까지)으로 넘어갔다.
function PrevNext({ path }: { path: string }) {
  const { site } = useSite()
  const group = site?.manual.find((g) => g.items.some((p) => p.path === path))
  if (!group) return null
  const list = group.items
  const i = list.findIndex((p) => p.path === path)
  const prev = list[i - 1]
  const next = list[i + 1]
  const Card = ({ p, dir }: { p?: Brief; dir: 'prev' | 'next' }) =>
    p ? (
      <Link to={pageUrl(p.path)} className={`flex-1 rounded-lg border p-4 hover:bg-accent ${dir === 'next' ? 'text-right' : ''}`}>
        <div className="flex items-center gap-1 text-xs text-muted-foreground" style={{ justifyContent: dir === 'next' ? 'flex-end' : 'flex-start' }}>
          {dir === 'prev' ? <ArrowLeft className="size-3.5" /> : null}
          {dir === 'prev' ? '이전' : '다음'}
          {dir === 'next' ? <ArrowRight className="size-3.5" /> : null}
        </div>
        <div className="mt-1 font-medium">{p.title}</div>
      </Link>
    ) : (
      <div className="flex-1" />
    )
  return (
    <div className="mt-12">
      <div className="flex gap-3">
        <Card p={prev} dir="prev" />
        <Card p={next} dir="next" />
      </div>
      <Link to={bookUrl(group.bundle, group.name)} className="mt-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <BookOpen className="size-3.5" /> 「{group.name || '매뉴얼'}」 권을 책으로 이어 읽기
      </Link>
    </div>
  )
}

export function MissingPage({ path }: { path: string }) {
  const { site } = useSite()
  const title = path.split('/').pop() || path
  return (
    <div className="max-w-[72ch]">
      <h1 className="text-3xl font-bold">{title}</h1>
      <p className="mt-4 text-muted-foreground">이 문서는 아직 없습니다.</p>
      {site?.user ? (
        <Button className="mt-4" asChild>
          <Link to={`/new?path=${encodeURIComponent(path)}`}>이 문서 쓰기</Link>
        </Button>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          <Link className="underline" to={`/login?next=${encodeURIComponent(`/new?path=${encodeURIComponent(path)}`)}`}>
            로그인
          </Link>
          하면 쓸 수 있습니다.
        </p>
      )}
    </div>
  )
}

// 문서 머리의 곁 칸 단추(이력 · 그래프). 손가락으로 누르는 화면에서는 44px 높이가 된다.
// 화면을 넘기는 「편집」은 이 묶음에 넣지 않는다 — 같은 모양이 하나는 화면을 넘기고 둘은 곁 칸을 여닫으면 잘못 누른다(2026.11.10).
function StripButton({ active, onClick, to, icon, children }: { active?: boolean; onClick?: () => void; to?: string; icon: ReactNode; children: ReactNode }) {
  const cls = cn(
    'inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground sm:flex-none pointer-coarse:h-11 pointer-coarse:px-3.5 [&_svg]:size-3.5',
    active && 'bg-background text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08)] ring-1 ring-border',
  )
  return to ? (
    <Link to={to} className={cls}>
      {icon}
      {children}
    </Link>
  ) : (
    <button type="button" className={cls} aria-expanded={active} onClick={onClick}>
      {icon}
      {children}
    </button>
  )
}

// onSide 를 주면 「이력」 · 「그래프」가 화면을 넘기지 않고 오른쪽 곁 칸의 그 탭을 연다.
// aside 를 주면 넓은 화면 오른쪽의 차례 자리에 그것을 둔다(대문의 최근 바뀜).
export function PageBody({ page, onSide, side, aside }: { page: Page; onSide?: (t: SideTab) => void; side?: SideTab | null; aside?: ReactNode }) {
  const { site } = useSite()
  return (
    <div className="flex gap-10">
      <article className="min-w-0 max-w-[72ch] flex-1">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">{page.title}</h1>
          {page.kind === 'concept' && page.aliases.length > 0 && <p className="mt-1.5 text-muted-foreground">{page.aliases.join(' · ')}</p>}
          {/* 문서 상태 띠 : 무슨 문서인지(종류 · 묶음) · 언제 누가 · 할 수 있는 일 */}
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3 text-sm text-muted-foreground">
            <KindTag kind={page.kind} className="text-foreground/80" />
            {/* 묶음이 여럿일 때만 : 같은 이름의 문서가 다른 묶음에도 있을 수 있어 어느 분야 문서인지 보인다 */}
            {page.bundle && (site?.bundles.length ?? 0) > 1 && <span>{page.bundle}</span>}
            {page.updated && (
              <span className="inline-flex items-center gap-1.5">
                <AuthorMark tag={page.updated.author} />
                <time dateTime={page.updated.date} title={when(page.updated.date)}>
                  {ago(page.updated.date)}
                </time>
              </span>
            )}
            <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
              <Button variant="outline" size="sm" className="pointer-coarse:h-11" asChild>
                <Link to={pageUrl(page.path, '/edit')}>
                  <Pencil /> 편집
                </Link>
              </Button>
              <div className="flex flex-1 items-center gap-0.5 rounded-lg bg-surface p-0.5 ring-1 ring-border/60 sm:flex-none">
                {onSide ? (
                  <>
                    <StripButton active={side === 'history'} onClick={() => onSide('history')} icon={<HistoryIcon />}>
                      이력
                    </StripButton>
                    <StripButton active={side === 'graph'} onClick={() => onSide('graph')} icon={<Network />}>
                      그래프
                    </StripButton>
                  </>
                ) : (
                  <>
                    <StripButton to={pageUrl(page.path, '/history')} icon={<HistoryIcon />}>
                      이력
                    </StripButton>
                    <StripButton to={`/graph?focus=${encodeURIComponent(page.path)}`} icon={<Network />}>
                      그래프
                    </StripButton>
                  </>
                )}
              </div>
            </div>
          </div>
        </header>
        {/* 오른쪽 자리를 곁 칸이나 aside(대문의 최근 바뀜)에 내주면 넓은 화면에서도 접는 차례를 쓴다 */}
        <FoldedToc body={page.body} always={!!side || !!aside} />
        <Markdown source={page.body} links={page.links} path={page.path} />
        {page.kind === 'manual' && <PrevNext path={page.path} />}
        {page.backlinks.length > 0 && (
          <section className="mt-14 border-t pt-6">
            <h2 className="text-sm font-semibold text-muted-foreground">이 문서를 가리키는 문서</h2>
            <ul className="mt-3 flex flex-wrap gap-2">
              {page.backlinks.map((b) => (
                <li key={b.path}>
                  <Link
                    to={pageUrl(b.path)}
                    className="inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-sm transition-colors hover:border-foreground/20 hover:bg-accent pointer-coarse:py-2.5"
                  >
                    <KindDot kind={b.kind} />
                    {b.title}
                    {dupTitles(page.backlinks)(b.title) && <span className="text-xs text-muted-foreground">{b.bundle}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </article>
      {!side && (aside ?? <Toc body={page.body} />)}
    </div>
  )
}

export function PageView({ path: fixed, aside }: { path?: string; aside?: ReactNode }) {
  const splat = useSplat()
  const path = fixed ?? splat
  const [page, setPage] = useState<Page | null>(null)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState('')
  // 곁 칸은 문서를 옮겨 다녀도 열린 채 남는다. 문서를 읽는 동안 page 가 비므로 PageBody 밖에서 쥔다.
  // 편집 · 이력 화면에 다녀오면 PageView 가 새로 그려지므로 고른 탭을 세션 저장소에 둔다.
  const [side, setSideState] = useState<SideTab | null>(loadSide)
  const setSide = useCallback((t: SideTab | null) => {
    setSideState(t)
    saveSide(t)
  }, [])
  const closeSide = useCallback(() => setSide(null), [setSide])
  // 열린 탭을 한 번 더 누르면 닫는다.
  const toggleSide = (t: SideTab) => setSide(side === t ? null : t)

  useEffect(() => {
    setPage(null)
    setMissing(false)
    setError('')
    get<Page>(`/api/page?${q(path)}`).then(
      (p) => {
        setPage(p)
        document.title = p.title
      },
      (e: ApiError) => (e.status === 404 ? setMissing(true) : setError(e.message)),
    )
  }, [path])

  useEffect(() => {
    if (page && location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView()
  }, [page])

  if (missing) return <MissingPage path={path} />
  if (error) return <p className="text-destructive">{error}</p>
  return (
    <div className="flex items-start gap-8">
      <div className="min-w-0 flex-1">{page && <PageBody page={page} side={side} onSide={toggleSide} aside={aside} />}</div>
      {side && <SidePanel path={path} tab={side} onTab={setSide} onClose={closeSide} />}
    </div>
  )
}
