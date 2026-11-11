import { useEffect } from 'react'
import { Link } from 'react-router'
import { bookUrl, type Brief } from '@/lib/api'
import { useSite } from '@/lib/site'

// 책장 : 매뉴얼 권마다 표지 하나. 누르면 그 권을 책으로 연다(/book/<묶음>/<권>).
// 2026.11.10 : 권은 차례의 묶음 머리 옆 작은 책 아이콘으로만 열 수 있어, 어떤 책이 있는지 한눈에 볼 곳이 없었다.
// 표지에 앞 장 제목 몇 개를 같이 둔다 — 표지만으로는 권 이름밖에 몰라 펼쳐 봐야 무슨 책인지 안다.
// 묶음별로 나누고, 이 묶음의 책 → 공유 묶음의 책 차례로 둔다(차례와 같은 차례).

type Volume = { name: string; bundle: string; about: string; items: Brief[] }

// 표지에 미리 보일 장 수. 표지 높이 안에 들도록 정했다.
const PREVIEW = 3

function BookCover({ v }: { v: Volume }) {
  const title = v.name || '매뉴얼'
  const rest = v.items.length - PREVIEW
  return (
    <Link
      to={bookUrl(v.bundle, v.name)}
      aria-label={`「${title}」 책 열기 · ${v.items.length}장`}
      // 왼쪽 굵은 선이 책등이다. 표지는 같은 크기로 둔다 — 책끼리는 견주는 짝이지 위아래가 없다.
      className="group flex aspect-[3/4] min-w-0 flex-col rounded-l-sm rounded-r-lg border border-l-[6px] border-l-foreground/75 bg-surface p-4 transition-[translate,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      <h3 className="line-clamp-3 text-lg leading-snug font-bold tracking-tight break-keep group-hover:text-link">{title}</h3>
      {v.about && <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{v.about}</p>}
      <div className="mt-auto pt-3">
        {v.items.length > 0 ? (
          <ol className="space-y-0.5 text-xs text-muted-foreground">
            {v.items.slice(0, PREVIEW).map((p, i) => (
              <li key={p.path} className="flex gap-1.5">
                <span className="w-3 shrink-0 text-right tabular-nums">{i + 1}</span>
                <span className="truncate">{p.title}</span>
              </li>
            ))}
            {rest > 0 && <li className="pl-[1.125rem]">외 {rest}장</li>}
          </ol>
        ) : (
          <p className="text-xs text-muted-foreground">아직 장이 없습니다</p>
        )}
        <p className="mt-2 border-t pt-2 text-xs font-medium tabular-nums">{v.items.length}장</p>
      </div>
    </Link>
  )
}

export function Shelf() {
  const { site } = useSite()
  useEffect(() => {
    document.title = '책장'
  }, [])
  if (!site) return <div className="h-40 animate-pulse rounded-lg bg-muted/60" />
  // 묶음별로 모은다. site.manual 이 이미 이 묶음 → 공유 묶음 차례다.
  const shelves: { bundle: string; books: Volume[] }[] = []
  for (const v of site.manual) {
    if (shelves.at(-1)?.bundle !== v.bundle) shelves.push({ bundle: v.bundle, books: [] })
    shelves.at(-1)!.books.push(v)
  }
  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold tracking-tight">책장</h1>
      {shelves.length === 0 && (
        <p className="mt-6 text-sm text-muted-foreground">
          아직 책이 없습니다.
          {site.user && (
            <Link to="/bundles" className="ml-1 text-link underline underline-offset-4">
              「묶음과 권」에서 권 만들기
            </Link>
          )}
        </p>
      )}
      {shelves.map((s) => (
        <section key={s.bundle} className="mt-8" aria-labelledby={`shelf-${s.bundle}`}>
          <h2 id={`shelf-${s.bundle}`} className="mb-3 text-sm font-semibold text-muted-foreground">
            {s.bundle}
            {site.shared.includes(s.bundle) && s.bundle !== site.bundle && <span className="font-normal"> · 모든 묶음에 함께 보임</span>}
          </h2>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {s.books.map((v) => (
              <li key={`${v.bundle}/${v.name}`} className="min-w-0">
                <BookCover v={v} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
