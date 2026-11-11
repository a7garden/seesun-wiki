import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { get, pageUrl, type Brief, type LinkMap } from '@/lib/api'

// 미리보기는 한 번 받으면 다시 받지 않는다. 같은 개념이 한 문서에 여러 번 나온다.
const cache = new Map<string, Promise<Brief>>()
function preview(name: string) {
  if (!cache.has(name)) cache.set(name, get<Brief>(`/api/preview?name=${encodeURIComponent(name)}`))
  return cache.get(name)!
}
export const forgetPreviews = () => cache.clear()

function Card({ name }: { name: string }) {
  const [b, setB] = useState<Brief | null>(null)
  useEffect(() => {
    preview(name).then(setB, () => setB(null))
  }, [name])
  if (!b) return <div className="h-16 animate-pulse rounded bg-muted" />
  return (
    <div className="flex gap-3">
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{b.title}</div>
        {b.aliases.length > 0 && <div className="text-xs text-muted-foreground">{b.aliases.join(' · ')}</div>}
        <p className="mt-1.5 text-sm leading-relaxed text-foreground/85">{b.summary || '아직 요약이 없습니다.'}</p>
      </div>
      {b.image && <img src={b.image} alt="" className="size-20 shrink-0 rounded-md border object-cover" />}
    </div>
  )
}

// 책 보기에서 같은 권 문서의 경로 → 그 장의 앵커(c3). 이 안의 링크는 다른 화면으로 가지 않고 책 안의 장으로 간다.
// 인쇄한 PDF 에서도 장끼리 링크가 살아 있게 하려는 것이다.
export const BookAnchors = createContext<Record<string, string> | null>(null)

export function WikiLink({ name, links, children }: { name: string; links: LinkMap; children: ReactNode }) {
  const hit = links[name]
  const anchor = useContext(BookAnchors)?.[hit?.path ?? '']
  if (anchor) return <a href={`#${anchor}`}>{children}</a>
  if (hit === null) {
    // 없는 문서는 붉게 두고, 누르면 그 이름으로 새로 쓴다.
    return (
      <Link className="missing" to={`/new?title=${encodeURIComponent(name)}`} title="아직 없는 문서">
        {children}
      </Link>
    )
  }
  const to = pageUrl(hit?.path ?? name)
  if (hit?.kind !== 'concept') return <Link to={to}>{children}</Link>
  return <ConceptLink to={to} path={hit.path} title={hit.title}>{children}</ConceptLink>
}

// 개념 링크 : 마우스가 있으면 올렸을 때 요약 카드, 손가락으로 누르는 화면이면 아래에서 올라오는 정의 시트.
// 2026.11.09 : 요약 카드는 마우스를 올려야 열려, 휴대폰에서는 누르자마자 다른 문서로 넘어가 버렸다.
//              읽던 자리를 떠나지 않고 용어를 확인하는 것이 이 링크의 쓸모라, 터치에서는 한 번 누르면 시트를 연다.
function ConceptLink({ to, path, title, children }: { to: string; path: string; title: string; children: ReactNode }) {
  const [sheet, setSheet] = useState(false)
  const nav = useNavigate()
  const touch = () => typeof matchMedia !== 'undefined' && matchMedia('(hover: none)').matches
  return (
    <>
      <HoverCard openDelay={250} closeDelay={80}>
        <HoverCardTrigger asChild>
          <Link
            to={to}
            className="concept"
            onClick={(e) => {
              if (!touch() || e.ctrlKey || e.metaKey) return
              e.preventDefault()
              setSheet(true)
            }}
          >
            {children}
          </Link>
        </HoverCardTrigger>
        <HoverCardContent className="w-96 max-w-[calc(100vw-2rem)]" side="bottom" align="start">
          <Card name={path} />
        </HoverCardContent>
      </HoverCard>
      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent side="bottom" className="max-h-[70svh] gap-0 rounded-t-2xl px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {/* 끌어 내리는 손잡이 모양 : 시트임을 알리는 표지 */}
          <span className="mx-auto mb-4 h-1 w-10 rounded-full bg-border" aria-hidden />
          <SheetTitle className="sr-only">{title}</SheetTitle>
          <SheetDescription className="sr-only">개념 요약</SheetDescription>
          <div className="overflow-y-auto">
            <Card name={path} />
          </div>
          <Button
            className="mt-5 h-11 w-full"
            onClick={() => {
              setSheet(false)
              nav(to)
            }}
          >
            「{title}」 문서 열기 <ArrowRight />
          </Button>
        </SheetContent>
      </Sheet>
    </>
  )
}

