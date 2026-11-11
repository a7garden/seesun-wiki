import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { ExternalLink, Pencil, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/Markdown'
import { BookAnchors } from '@/components/WikiLink'
import { tocHeadings } from '@/lib/headings'
import { get, pageUrl, q, when, type Page } from '@/lib/api'
import { useSite } from '@/lib/site'
import { cn } from '@/lib/utils'
import { useActiveHeading, useSplat } from './PageView'

// 권 하나를 책처럼 : 표지 · 차례 · 모든 장을 한 화면에 이어 붙인 본문. 주소는 /book/<묶음>/<권>.
// 2026.11.10 : 다른 위키를 본 뒤 정한 꼴이다.
//   BookStack — 권 첫 화면이 표지 겸 차례 · mdBook — 장을 한 화면에 이어 붙이고 PDF 는 브라우저 인쇄에 맡긴다.
//   서버에서 PDF 를 만드는 쪽(MediaWiki · Confluence)은 유지가 어려워 꺼지거나 유료 앱으로 넘어갔다.
//   GitBook 은 PDF 에서 다른 문서로 가는 링크가 끊긴다 — 그래서 같은 권 안의 [[링크]] 는 책 안의 장 앵커로 바꾼다(BookAnchors).
//   Confluence 는 PDF 차례가 문서 계층을 잃는다는 불만이 많다 — 그래서 차례에 장 아래 절(##)까지 들여 보인다.
// 제목 id 는 장마다 c<번호>- 를 앞에 붙인다. 붙이지 않으면 장마다 있는 「개요」 같은 절의 id 가 겹쳐 차례가 첫 장으로만 간다.

type Chapter = { page: Page; id: string; sections: { id: string; text: string }[] }

// 인쇄 전에 늦게 받는 그림(loading=lazy)을 모두 받아 둔다. 받지 않은 그림은 PDF 에 빈칸으로 찍힌다.
// 인쇄 창은 단추로만 연다 — mdBook 은 이 화면에 돌아올 때마다 인쇄 창이 다시 뜨는 문제를 겪었다.
async function printBook() {
  const imgs = [...document.querySelectorAll<HTMLImageElement>('#main img')]
  imgs.forEach((i) => (i.loading = 'eager'))
  const loaded = Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => (i.addEventListener('load', r, { once: true }), i.addEventListener('error', r, { once: true }))))))
  await Promise.race([loaded, new Promise((r) => setTimeout(r, 5000))])
  window.print()
}

// 오른쪽 차례 : 장은 늘 보이고, 지금 읽는 장의 절만 펼친다. 장이 수십 개여도 한 화면에 든다.
function BookToc({ chapters }: { chapters: Chapter[] }) {
  const entries = useMemo(() => chapters.flatMap((c, n) => [{ id: c.id, ch: n }, ...c.sections.map((s) => ({ id: s.id, ch: n }))]), [chapters])
  const ids = useMemo(() => entries.map((e) => e.id), [entries])
  const active = useActiveHeading(ids)
  const activeId = ids[active]
  const activeCh = entries[active]?.ch ?? -1
  return (
    <nav className="sticky top-20 hidden max-h-[calc(100svh-6rem)] w-56 shrink-0 overflow-y-auto text-sm xl:block print:hidden" aria-label="이 권의 차례">
      <p className="mb-3 text-xs font-medium text-muted-foreground">이 권에서</p>
      <ol className="space-y-0.5 border-l pl-3.5">
        {chapters.map((c, n) => (
          <li key={c.id}>
            <a
              href={`#${c.id}`}
              aria-current={activeId === c.id ? 'location' : undefined}
              className={cn('flex gap-2 py-1 leading-snug transition-colors', n === activeCh ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              <span className="w-4 shrink-0 text-right tabular-nums">{n + 1}</span>
              {c.page.title}
            </a>
            {n === activeCh && c.sections.length > 0 && (
              <ul className="mb-1 ml-6 space-y-0.5">
                {c.sections.map((s) => (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      aria-current={activeId === s.id ? 'location' : undefined}
                      className={cn('block py-0.5 leading-snug transition-colors', activeId === s.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
                    >
                      {s.text}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}

export function Book() {
  const splat = useSplat()
  const [bundle, ...rest] = splat.split('/')
  const name = rest.join('/')
  const { site } = useSite()
  // 다른 묶음의 권을 주소로 열면 사이트 정보가 그 묶음으로 바뀔 때까지 기다린다(site.tsx 가 주소를 보고 바꾼다).
  const ready = !!site && (site.bundle === bundle || site.shared.includes(bundle))
  const noBundle = !!site && !site.bundles.some((b) => b.name === bundle)
  const group = ready ? site.manual.find((g) => g.bundle === bundle && g.name === name) : undefined
  const paths = useMemo(() => group?.items.map((p) => p.path) ?? [], [group])
  const [pages, setPages] = useState<Page[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!paths.length) return
    setPages(null)
    setError('')
    Promise.all(paths.map((p) => get<Page>(`/api/page?${q(p)}`))).then(setPages, (e: Error) => setError(e.message))
  }, [paths])

  useEffect(() => {
    if (group) document.title = group.name || '매뉴얼'
  }, [group])

  const chapters = useMemo<Chapter[]>(
    () =>
      (pages ?? []).map((page, n) => ({
        page,
        id: `c${n + 1}`,
        sections: tocHeadings(page.body)
          .filter((h) => h.depth === 2)
          .map((h) => ({ id: `c${n + 1}-${h.id}`, text: h.text })),
      })),
    [pages],
  )
  const anchors = useMemo(() => Object.fromEntries(chapters.map((c) => [c.page.path, c.id])), [chapters])
  const lastEdit = useMemo(() => chapters.map((c) => c.page.updated?.date ?? '').sort().pop(), [chapters])

  // 장 · 절 주소(#c2-개요)로 열었으면 다 그린 뒤 그 자리로 간다
  useEffect(() => {
    if (pages && location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView()
  }, [pages])

  if (noBundle || (ready && !group)) return <p className="text-muted-foreground">없는 권입니다.</p>
  if (error) return <p className="text-destructive">{error}</p>
  if (!group) return <div className="h-40 animate-pulse rounded-lg bg-muted/60" />
  const title = group.name || '매뉴얼'

  return (
    <div className="flex gap-10">
      <article className="min-w-0 max-w-[72ch] flex-1">
        {/* 표지 */}
        <header className="border-b pb-8">
          {/* 앞 화면은 책장이다. 다른 책으로 갈 문을 표지 위에 둔다 */}
          <p className="text-sm text-muted-foreground print:hidden">
            <Link to="/books" className="hover:text-foreground hover:underline">
              책장
            </Link>{' '}
            › {bundle}
          </p>
          <p className="hidden text-sm text-muted-foreground print:block">{bundle} · 매뉴얼</p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight">{title}</h1>
          {group.about && <p className="mt-4 text-lg leading-relaxed text-foreground/80">{group.about}</p>}
          <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3 text-sm text-muted-foreground">
            <span>{group.items.length}장</span>
            {lastEdit && <span>마지막 고침 {when(lastEdit).slice(0, 10)}</span>}
            <Button variant="outline" size="sm" className="ml-auto print:hidden" onClick={printBook} disabled={!pages}>
              <Printer /> 인쇄 · PDF 저장
            </Button>
          </div>
        </header>

        {group.items.length === 0 && <p className="mt-8 text-muted-foreground">이 권에는 아직 문서가 없습니다.</p>}

        {/* 차례 : 장 아래 절까지 들여 보인다 */}
        {group.items.length > 0 && (
          <nav className="mt-8" aria-label="차례">
            <h2 className="text-sm font-semibold text-muted-foreground">차례</h2>
            <ol className="mt-3 space-y-3">
              {group.items.map((p, n) => (
                <li key={p.path}>
                  <a href={`#c${n + 1}`} className="flex gap-3 font-medium hover:underline">
                    <span className="w-5 shrink-0 text-right text-muted-foreground tabular-nums">{n + 1}</span>
                    {p.title}
                  </a>
                  {chapters[n] && chapters[n].sections.length > 0 && (
                    <ul className="mt-1 ml-8 space-y-0.5 text-sm">
                      {chapters[n].sections.map((s) => (
                        <li key={s.id}>
                          <a href={`#${s.id}`} className="text-muted-foreground hover:text-foreground">
                            {s.text}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}

        {!pages && group.items.length > 0 && <div className="mt-12 h-40 animate-pulse rounded-lg bg-muted/60" />}

        {/* 본문 : 장마다 새 쪽에서 시작한다(인쇄) */}
        <BookAnchors.Provider value={anchors}>
          {chapters.map((c, n) => (
            <section key={c.id} id={c.id} className="mt-16 scroll-mt-20 border-t pt-10 print:mt-0 print:break-before-page print:border-0 print:pt-0">
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span>{n + 1}장</span>
                <span className="ml-auto flex gap-3 print:hidden">
                  <Link to={pageUrl(c.page.path)} className="inline-flex items-center gap-1 hover:text-foreground">
                    <ExternalLink className="size-3.5" /> 이 장만 열기
                  </Link>
                  <Link to={pageUrl(c.page.path, '/edit')} className="inline-flex items-center gap-1 hover:text-foreground">
                    <Pencil className="size-3.5" /> 고치기
                  </Link>
                </span>
              </div>
              <h2 className="mt-1 mb-6 text-3xl font-bold tracking-tight">{c.page.title}</h2>
              <Markdown source={c.page.body} links={c.page.links} path={c.page.path} idPrefix={`${c.id}-`} />
            </section>
          ))}
        </BookAnchors.Provider>
      </article>
      {chapters.length > 0 && <BookToc chapters={chapters} />}
    </div>
  )
}
