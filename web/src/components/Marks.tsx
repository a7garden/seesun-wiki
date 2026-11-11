import type { Kind } from '@/lib/api'
import { KIND_NAME } from '@/lib/api'
import { cn } from '@/lib/utils'

// 위키 곳곳에서 쓰는 작은 표지 둘.
//   AuthorMark : 고친 사람. 이 위키는 이름 대신 계정 해시(tag)만 남긴다(server/src/auth.rs 머리말).
//                여섯 글자 해시는 눈으로 가리기 어려워, 해시에서 무늬와 색을 뽑은 3×3 그림을 앞에 붙인다 —
//                같은 사람은 늘 같은 그림이라 이력에서 「아까 그 사람」을 글자를 읽지 않고 알아본다.
//                AI 도구(MCP)로 고친 판은 해시 대신 「도구」로 적힌 커밋도 있어, 16진수가 아니면 회색 칸으로 둔다.
//   KindDot    : 문서 종류. 그래프 점과 같은 색(개념 초록 · 매뉴얼 파랑 · 일반 회색)이라 화면을 오가도 같은 뜻으로 읽힌다.

function bitsOf(tag: string) {
  const hex = tag.replace(/[^0-9a-f]/gi, '')
  if (hex.length < 4) return null
  const n = parseInt(hex.slice(0, 6).padEnd(6, '0'), 16)
  return { cells: n & 0x3f, hue: Math.round(((n >> 6) % 360 + 360) % 360) }
}

export function AuthorGlyph({ tag, className }: { tag: string; className?: string }) {
  const b = bitsOf(tag)
  // 사람 계정이 아닌 커밋(「위키」 · 「가져오기」)은 무늬 대신 첫 글자를 둔다. 빈 칸으로 두면 체크 상자처럼 보였다.
  if (!b)
    return (
      <span className={cn('grid size-3.5 shrink-0 place-items-center rounded-[3px] bg-muted text-[9px] leading-none font-semibold text-muted-foreground', className)} aria-hidden>
        {tag.slice(0, 1)}
      </span>
    )
  // 왼쪽 두 열을 비트로 정하고 오른쪽 열은 왼쪽을 비춘다. 좌우가 맞으면 무늬가 「얼굴」처럼 읽혀 기억에 남는다.
  const on = (col: number, row: number) => (b.cells >> (row * 2 + (col === 2 ? 0 : col))) & 1
  const fill = `oklch(0.6 0.11 ${b.hue})`
  return (
    <svg viewBox="0 0 3 3" className={cn('size-3.5 shrink-0 rounded-[3px]', className)} style={{ background: `oklch(0.6 0.11 ${b.hue} / 0.16)` }} aria-hidden>
      {[0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => (on(col, row) ? <rect key={`${col}${row}`} x={col} y={row} width="1" height="1" fill={fill} /> : null)))}
    </svg>
  )
}

export function AuthorMark({ tag, className }: { tag: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)} title={`고친 사람 ${tag}`}>
      <AuthorGlyph tag={tag} />
      <span className="font-mono text-[0.92em] tracking-tight">{tag}</span>
    </span>
  )
}

/** 같은 제목이 여러 묶음에 있으면(공통/대문 · 산사태/대문) 목록에서 가릴 수 있게 묶음 이름을 붙인다. */
export function dupTitles(items: { title: string }[]) {
  const seen = new Map<string, number>()
  for (const i of items) seen.set(i.title, (seen.get(i.title) ?? 0) + 1)
  return (title: string) => (seen.get(title) ?? 0) > 1
}

const KIND_BG: Record<Kind, string> = { concept: 'bg-kind-concept', manual: 'bg-kind-manual', page: 'bg-kind-page' }

export function KindDot({ kind, className }: { kind: Kind; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', KIND_BG[kind], className)} aria-hidden />
}

/** 종류 이름표 : 점 + 이름. 문서 머리 · 찾기 결과에 쓴다. */
export function KindTag({ kind, className }: { kind: Kind; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <KindDot kind={kind} />
      {KIND_NAME[kind]}
    </span>
  )
}
