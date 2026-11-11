import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ChevronDown } from 'lucide-react'
import { AuthorMark } from '@/components/Marks'
import { ago, get, pageUrl, q, when, type Commit } from '@/lib/api'
import { cn } from '@/lib/utils'

// 이력 등뼈 : 판을 세로 줄기 위의 점으로 늘어놓는다. 곁 칸의 「이력」 탭과 이력 화면이 함께 쓴다.
//   점 크기 = 그 판에서 바뀐 줄 수(더한 줄 + 뺀 줄). 큰 고침과 글자 하나 고친 판이 한눈에 갈린다.
//   「바뀐 곳」은 화면을 넘기지 않고 그 자리에서 펼친다 — 판을 훑으며 무엇이 바뀌었는지 보는 것이 이력을 여는 까닭이다.

const short = (h: string) => h.slice(0, 7)

/** git diff 에서 머리(파일 이름 · 색인 줄)를 뺀 줄들. */
export function diffLines(diff: string) {
  return diff.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(l))
}

export function DiffView({ diff, className }: { diff: string; className?: string }) {
  const lines = diffLines(diff)
  if (!lines.join('').trim()) return <p className="text-sm text-muted-foreground">본문은 같습니다.</p>
  return (
    <div className={cn('diff overflow-hidden rounded-lg border', className)}>
      {lines.map((l, i) => (
        <div key={i} className={`px-3 ${l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk border-y bg-surface py-1' : ''}`}>
          {l || ' '}
        </div>
      ))}
    </div>
  )
}

function dotSize(c: Commit) {
  const n = (c.added ?? 0) + (c.removed ?? 0)
  return Math.round(Math.min(16, 7 + Math.log2(n + 1) * 1.35))
}

function InlineDiff({ path, a, b }: { path: string; a?: string; b: string }) {
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    get<{ diff: string }>(`/api/diff?${q(path)}&${a ? `a=${a}&` : ''}b=${b}`).then((d) => setDiff(d.diff), (e) => setError(e.message))
  }, [path, a, b])
  if (error) return <p className="text-xs text-destructive">{error}</p>
  if (diff === null) return <div className="h-16 animate-pulse rounded-lg bg-muted" />
  return <DiffView diff={diff} className="max-h-72 overflow-y-auto text-[12px]" />
}

// onView 를 주면 넓은 화면(xl)에서 「이 판 보기」가 화면을 넘기지 않고 부르는 쪽 옆 칸에 그 판을 편다. 좁은 화면은 그대로 판 화면으로 간다.
export function HistorySpine({
  path,
  list,
  compact = false,
  actions,
  onView,
  viewing,
}: {
  path: string
  list: Commit[]
  compact?: boolean
  actions?: (c: Commit, i: number) => ReactNode
  onView?: (c: Commit) => void
  viewing?: string
}) {
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => setOpen(null), [path])
  return (
    <ol className={cn('relative', compact ? 'px-3 py-2' : '')}>
      {list.map((c, i) => {
        const prev = list[i + 1]
        const size = dotSize(c)
        const isOpen = open === c.hash
        return (
          <li key={c.hash} className="relative flex gap-3 pb-4 last:pb-1">
            {/* 줄기 : 점과 점을 잇는다. 마지막 판 아래로는 그리지 않는다 */}
            <div className="relative flex w-4 shrink-0 justify-center pt-1">
              {i < list.length - 1 && <span className="absolute top-3 -bottom-1 w-px bg-border" aria-hidden />}
              <span
                className={cn('relative rounded-full ring-4 ring-background', i === 0 ? 'bg-primary' : 'border-2 border-primary/55 bg-background')}
                style={{ width: size, height: size, marginTop: (16 - size) / 2 }}
                title={c.added != null ? `더한 줄 ${c.added} · 뺀 줄 ${c.removed}` : undefined}
                aria-hidden
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className={cn('font-medium break-words', compact ? 'text-sm' : '')}>{c.subject}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
                <AuthorMark tag={c.author} />
                <time dateTime={c.date} title={when(c.date)}>
                  {ago(c.date)}
                </time>
                {c.added != null && (
                  <span className="font-mono tabular-nums">
                    <span className="text-add">+{c.added}</span> <span className="text-del">−{c.removed}</span>
                  </span>
                )}
                {!compact && <span className="font-mono">{short(c.hash)}</span>}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : c.hash)}
                  className="tap inline-flex h-7 items-center gap-1 rounded-md px-2 text-muted-foreground ring-1 ring-border transition-colors hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
                >
                  바뀐 곳
                  <ChevronDown className={cn('size-3 transition-transform', isOpen && 'rotate-180')} />
                </button>
                <Link className={cn('tap inline-flex h-7 items-center rounded-md px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground', onView && 'xl:hidden')} to={`${pageUrl(path, '/rev')}?r=${c.hash}`}>
                  이 판 보기
                </Link>
                {onView && (
                  <button
                    type="button"
                    aria-pressed={viewing === c.hash}
                    onClick={() => onView(c)}
                    className="tap hidden h-7 items-center rounded-md px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:font-medium aria-pressed:text-foreground xl:inline-flex"
                  >
                    이 판 보기
                  </button>
                )}
                {actions?.(c, i)}
              </div>
              {isOpen && (
                <div className="mt-2">
                  <InlineDiff path={path} a={prev?.hash} b={c.hash} />
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
