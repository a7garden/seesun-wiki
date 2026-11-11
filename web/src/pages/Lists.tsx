import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ArrowRight, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Highlight } from '@/components/CommandPalette'
import { AuthorMark, KindDot } from '@/components/Marks'
import { crumbs, dayLabel, get, pageUrl, when, type Brief, type Commit } from '@/lib/api'
import { scopeLabel, scopeOf, useSite } from '@/lib/site'
import { cn } from '@/lib/utils'
import { PageView } from './PageView'

// 목록 화면들 : 최근 바뀜(변경 타임라인) · 모든 개념(개념 사전) · 찾기 결과 · 대문.

// ── 1. 변경 타임라인
// 2026.11.09 : 전에는 판 하나에 바뀐 문서를 모두 링크로 늘어놓아, 문서 70개를 옮긴 판 하나가 화면을 덮었고
//              옮기기 전 경로의 판은 지금 그 경로에 문서가 없어 「(지움)」으로 잘못 보였다.
//              서버가 옮김(R)과 지금 경로(now)를 함께 주므로, 판마다 바뀐 문서를 넷까지만 보이고 나머지는 접는다.
type ChangeCommit = Commit & { titles: Record<string, string | null>; now?: Record<string, string> }
type Entry = { key: string; to: string; title: string; status: string; gone: boolean }

const STATUS: Record<string, { label: string; cls: string }> = {
  A: { label: '새로', cls: 'text-add' },
  D: { label: '지움', cls: 'text-del' },
  R: { label: '옮김', cls: 'text-muted-foreground' },
}

function entriesOf(c: ChangeCommit): Entry[] {
  const raw = c.changes?.length ? c.changes : c.files.map((path) => ({ status: 'M', path }))
  return raw.map((ch) => {
    const title = c.titles[ch.path]
    const now = c.now?.[ch.path] ?? ch.path
    return { key: ch.path, to: title ? pageUrl(now) : pageUrl(ch.path, '/history'), title: title ?? ch.path.split('/').pop() ?? ch.path, status: ch.status, gone: title == null }
  })
}

const SHOW = 4

function ChangeRow({ c, last }: { c: ChangeCommit; last: boolean }) {
  const [open, setOpen] = useState(false)
  const items = entriesOf(c)
  const moved = items.length > 1 && items.every((e) => e.status === 'R' || e.status === 'A')
  const shown = open ? items : items.slice(0, SHOW)
  return (
    <li className="relative grid grid-cols-[3rem_1rem_1fr] gap-x-3">
      <time dateTime={c.date} title={when(c.date)} className="pt-0.5 text-right text-xs text-muted-foreground tabular-nums">
        {when(c.date).slice(11)}
      </time>
      <div className="relative flex justify-center pt-1.5">
        {!last && <span className="absolute top-4 -bottom-1.5 w-px bg-border" aria-hidden />}
        <span className="size-2 rounded-full bg-primary/70 ring-4 ring-background" aria-hidden />
      </div>
      <div className="min-w-0 pb-6">
        <div className="text-[15px] leading-snug font-medium break-words">{c.subject}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 text-xs text-muted-foreground">
          <AuthorMark tag={c.author} />
          <span>
            문서 {items.length}개{moved ? ' · 옮기거나 새로 씀' : ''}
          </span>
        </div>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {shown.map((e) => (
            <li key={e.key}>
              <Link
                to={e.to}
                title={e.gone ? '지금은 없는 문서 — 이력을 엽니다' : undefined}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-0.5 text-[13px] transition-colors hover:border-foreground/25 hover:bg-accent pointer-coarse:py-2',
                  e.gone && 'text-muted-foreground line-through decoration-del/60',
                )}
              >
                {STATUS[e.status] && <span className={cn('text-[11px] font-medium no-underline', STATUS[e.status].cls)}>{STATUS[e.status].label}</span>}
                {e.title}
              </Link>
            </li>
          ))}
          {items.length > SHOW && (
            <li>
              <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                className="inline-flex items-center rounded-md px-2 py-0.5 text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline pointer-coarse:py-2"
              >
                {open ? '접기' : `외 ${items.length - SHOW}개 더 보기`}
              </button>
            </li>
          )}
        </ul>
      </div>
    </li>
  )
}

// rail : 대문 오른쪽 좁은 칸에 둘 때. 칸이 따로 스크롤되므로 날짜 머리를 머리줄 아래에 붙이지 않는다.
export function ChangeList({ limit, rail = false }: { limit?: number; rail?: boolean }) {
  const [list, setList] = useState<ChangeCommit[] | null>(null)
  useEffect(() => {
    get<ChangeCommit[]>('/api/changes').then(setList, () => setList([]))
  }, [])
  const days = useMemo(() => {
    const out: { label: string; items: ChangeCommit[] }[] = []
    for (const c of (list ?? []).slice(0, limit)) {
      const label = dayLabel(c.date)
      if (out.at(-1)?.label !== label) out.push({ label, items: [] })
      out.at(-1)!.items.push(c)
    }
    return out
  }, [list, limit])
  if (!list)
    return (
      <div className="space-y-5" aria-label="불러오는 중">
        {[0, 1, 2].map((i) => (
          <div key={i} className="ml-[4.75rem] space-y-2">
            <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    )
  if (!list.length) return <p className="text-muted-foreground">아직 바뀐 문서가 없습니다.</p>
  return (
    <div className="space-y-2">
      {days.map((d) => (
        <section key={d.label}>
          <h3 className={cn('mb-3 text-sm font-semibold', !rail && 'sticky top-14 z-10 -mx-1 bg-background/90 px-1 py-1.5 backdrop-blur')}>
            {d.label} <span className="font-normal text-muted-foreground tabular-nums">· {d.items.length}</span>
          </h3>
          <ol>
            {d.items.map((c, i) => (
              <ChangeRow key={c.hash} c={c} last={i === d.items.length - 1} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
}

export function Changes() {
  return (
    <div className="max-w-3xl">
      <h1 className="mb-8 text-2xl font-bold tracking-tight">최근 바뀜</h1>
      <ChangeList />
    </div>
  )
}

// ── 2. 개념 사전
// 한글 첫 글자의 초성으로 묶는다. 쌍자음은 홑자음 칸에 넣는다.
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'
const FOLD: Record<string, string> = { ㄲ: 'ㄱ', ㄸ: 'ㄷ', ㅃ: 'ㅂ', ㅆ: 'ㅅ', ㅉ: 'ㅈ' }
function initial(s: string) {
  const c = s.charCodeAt(0)
  if (c >= 0xac00 && c <= 0xd7a3) {
    const ch = CHO[Math.floor((c - 0xac00) / 588)]
    return FOLD[ch] || ch
  }
  return /[a-z]/i.test(s[0]) ? s[0].toUpperCase() : '#'
}

const jump = (k: string) => document.getElementById(`ch-${k}`)?.scrollIntoView({ block: 'start' })

// 초성 레일 : 휴대폰 연락처처럼 화면 오른쪽에 붙은 ㄱ~ㅎ 막대. 손가락으로 훑으면 그 초성으로 바로 간다.
function InitialRail({ keys, active }: { keys: string[]; active: string }) {
  const rail = useRef<HTMLDivElement>(null)
  const [touching, setTouching] = useState('')
  const pick = (y: number) => {
    const r = rail.current!.getBoundingClientRect()
    const i = Math.min(keys.length - 1, Math.max(0, Math.floor(((y - r.top) / r.height) * keys.length)))
    if (keys[i] !== touching) {
      setTouching(keys[i])
      jump(keys[i])
    }
  }
  return (
    <>
      <div
        ref={rail}
        role="navigation"
        aria-label="초성으로 건너뛰기"
        className="fixed top-1/2 right-0.5 z-20 flex -translate-y-1/2 touch-none flex-col items-center rounded-full bg-background/80 px-1 py-1.5 backdrop-blur select-none sm:hidden"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          pick(e.clientY)
        }}
        onPointerMove={(e) => e.buttons && pick(e.clientY)}
        onPointerUp={() => setTouching('')}
        onPointerCancel={() => setTouching('')}
        onLostPointerCapture={() => setTouching('')}
      >
        {keys.map((k) => (
          <span key={k} className={cn('grid h-[min(1.6rem,4.6svh)] w-6 place-items-center text-[11px] font-medium', k === active ? 'text-primary' : 'text-muted-foreground')}>
            {k}
          </span>
        ))}
      </div>
      {/* 훑는 동안 손가락에 가리지 않게 화면 가운데에 지금 초성을 크게 보인다 */}
      {touching && (
        <div className="pointer-events-none fixed top-1/2 left-1/2 z-30 grid size-20 -translate-1/2 place-items-center rounded-2xl bg-foreground/80 text-3xl font-bold text-background sm:hidden" aria-hidden>
          {touching}
        </div>
      )}
    </>
  )
}

// 거르기 칸 하나 : 「전체」 + 값들. 고른 값은 주소에 남겨 새로 고침 · 링크 건네기에도 그대로 보이게 한다.
function Filter({ label, all, values, value, onChange }: { label: string; all: string; values: { v: string; n: number }[]; value: string; onChange: (v: string) => void }) {
  const opts = [{ v: '', n: -1, label: all }, ...values.map((x) => ({ ...x, label: x.v }))]
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-8 shrink-0 text-xs font-semibold text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={label}>
        {opts.map((o) => (
          <button
            key={o.v || '*'}
            role="radio"
            aria-checked={value === o.v}
            onClick={() => onChange(o.v)}
            className={cn(
              'rounded-full border px-3 py-1 text-sm transition-colors pointer-coarse:py-2',
              value === o.v ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {o.label}
            {o.n >= 0 && <span className="ml-1 text-xs opacity-70">{o.n}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

type ConceptRow = Brief & { orgs: string[] }

export function Concepts() {
  const { site } = useSite()
  // 2026.11.10 : 이 묶음과 공통의 개념(site.concepts)만 보이던 것을, 모든 묶음의 개념을 받아 묶음 · 본부 · 글자로 거르게 바꿨다.
  //              본부는 그 개념을 쓰거나 고친 사람의 소속이다(서버가 git 이력에서 모은다).
  const [all, setAll] = useState<ConceptRow[] | null>(null)
  useEffect(() => {
    get<ConceptRow[]>('/api/concepts').then(setAll, () => setAll([]))
  }, [site])
  const [params, setParams] = useSearchParams()
  const bundle = params.get('bundle') || ''
  const org = params.get('org') || ''
  const text = params.get('q') || ''
  const set = (k: string, v: string) =>
    setParams(
      (p) => {
        if (v) p.set(k, v)
        else p.delete(k)
        return p
      },
      { replace: true },
    )
  // 개념이 둘 이상의 묶음에 걸쳐 있을 때만 줄마다 묶음 이름(거르기 단추)을 붙인다
  const many = useMemo(() => new Set((all ?? []).map((c) => c.bundle)).size > 1, [all])
  const orgOpts = useMemo(() => (site?.orgs ?? []).map((o) => ({ v: o, n: (all ?? []).filter((c) => c.orgs.includes(o)).length })), [all, site])
  const shown = useMemo(() => {
    const t = text.trim().toLowerCase()
    return (all ?? []).filter(
      (c) =>
        (!bundle || c.bundle === bundle) &&
        (!org || c.orgs.includes(org)) &&
        (!t || [c.title, c.summary, ...c.aliases].some((s) => s.toLowerCase().includes(t))),
    )
  }, [all, bundle, org, text])
  const groups = useMemo(() => {
    const m = new Map<string, Brief[]>()
    for (const c of shown) {
      const k = initial(c.title)
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(c)
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b, 'ko'))
  }, [shown])
  const keys = useMemo(() => groups.map(([k]) => k), [groups])
  const [active, setActive] = useState('')
  useEffect(() => {
    let raf = 0
    const measure = () => {
      raf = 0
      let cur = keys[0] ?? ''
      for (const k of keys) {
        const el = document.getElementById(`ch-${k}`)
        if (el && el.getBoundingClientRect().top <= 140) cur = k
      }
      setActive(cur)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    measure()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onScroll)
    }
  }, [keys])
  const filtered = !!(bundle || org || text)
  return (
    <div className="max-w-4xl pr-6 sm:pr-0">
      <h1 className="text-2xl font-bold tracking-tight">개념</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {all === null ? '불러오는 중…' : filtered ? `용어 ${all.length}개 가운데 ${shown.length}개` : `용어 ${all.length}개`}
      </p>
      <div className="mt-4 space-y-2.5">
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={text} onChange={(e) => set('q', e.target.value)} placeholder="이름 · 별칭 · 요약으로 거르기" className="h-9 pl-9" aria-label="개념 거르기" />
        </div>
        {/* 묶음은 줄마다 붙은 묶음 이름을 눌러 거른다. 거르는 중일 때만 여기에 풀기 단추를 보인다 */}
        {bundle && (
          <div className="flex items-center gap-2">
            <span className="w-8 shrink-0 text-xs font-semibold text-muted-foreground">묶음</span>
            <button
              type="button"
              onClick={() => set('bundle', '')}
              aria-label={`묶음 거르기 풀기 · 지금 ${bundle}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-primary bg-primary px-3 py-1 text-sm text-primary-foreground pointer-coarse:py-2"
            >
              {bundle}
              <X className="size-3.5" />
            </button>
          </div>
        )}
        {orgOpts.length > 0 && <Filter label="본부" all="모든 본부" values={orgOpts} value={org} onChange={(v) => set('org', v)} />}
      </div>
      {all !== null && shown.length === 0 && (
        <p className="mt-8 text-sm text-muted-foreground">
          맞는 개념이 없습니다.{' '}
          <button className="text-link underline underline-offset-4" onClick={() => setParams({}, { replace: true })}>
            거르기 풀기
          </button>
        </p>
      )}
      {/* 넓은 화면 : 글을 내려도 위에 붙어 있는 초성 막대. 지금 보는 초성이 표시된다 */}
      <nav className="sticky top-14 z-10 -mx-2 mt-4 hidden flex-wrap gap-0.5 bg-background/90 px-2 py-2 backdrop-blur sm:flex" aria-label="초성으로 건너뛰기">
        {keys.map((k) => (
          <a
            key={k}
            href={`#ch-${k}`}
            aria-current={k === active ? 'true' : undefined}
            className={cn('grid size-8 place-items-center rounded-md text-sm transition-colors hover:bg-accent', k === active ? 'bg-primary text-primary-foreground hover:bg-primary' : 'text-muted-foreground')}
          >
            {k}
          </a>
        ))}
      </nav>
      <InitialRail keys={keys} active={active} />
      {groups.map(([k, items]) => (
        <section key={k} id={`ch-${k}`} className="mt-8 scroll-mt-28 sm:grid sm:grid-cols-[3rem_1fr] sm:gap-4">
          <h2 className="mb-2 text-2xl leading-none font-bold text-primary sm:sticky sm:top-28 sm:mb-0 sm:self-start">{k}</h2>
          <ul className="grid gap-x-10 sm:grid-cols-2">
            {items.map((c) => (
              // 줄 전체가 문서 링크다(제목 링크의 ::after 가 줄을 덮는다). 묶음 이름 단추만 그 위에 올라 거르기를 한다.
              <li key={c.path} className="group relative flex gap-3 border-t py-3.5 first:border-t-0 sm:[&:nth-child(2)]:border-t-0">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <Link to={pageUrl(c.path)} className="font-semibold after:absolute after:inset-0 group-hover:text-link group-hover:underline group-hover:underline-offset-4">
                      {c.title}
                    </Link>
                    {many && !bundle && (
                      <button
                        type="button"
                        onClick={() => set('bundle', c.bundle)}
                        title={`「${c.bundle}」 묶음만 보기`}
                        className="relative z-10 rounded px-1 text-xs text-muted-foreground underline-offset-4 hover:bg-accent hover:text-foreground hover:underline pointer-coarse:py-1.5"
                      >
                        {c.bundle}
                      </button>
                    )}
                  </div>
                  {c.aliases.length > 0 && <div className="text-xs text-muted-foreground">{c.aliases.join(' · ')}</div>}
                  <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{c.summary}</p>
                </div>
                {c.image && <img src={c.image} alt="" loading="lazy" className="size-14 shrink-0 rounded-md border object-cover" />}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

// ── 3. 찾기 결과
// 찾기 범위 : 주소의 b(묶음)가 있으면 그 묶음과 공통, 없으면 위키 전체.
export function SearchPage() {
  const { site } = useSite()
  const [params, setParams] = useSearchParams()
  const term = params.get('q') || ''
  const scope = params.get('b') || ''
  const [draft, setDraft] = useState(term)
  const [list, setList] = useState<(Brief & { snippet: string })[] | null>(null)
  useEffect(() => {
    setDraft(term)
    if (!term) return setList(null)
    setList(null)
    get<(Brief & { snippet: string })[]>(`/api/search?q=${encodeURIComponent(term)}${scope ? `&b=${encodeURIComponent(scope)}` : ''}`).then(setList, () => setList([]))
  }, [term, scope])
  const here = scopeOf(site)
  const go = (q: string, b: string) => setParams(b ? { q, b } : { q })
  return (
    <div className="max-w-3xl">
      <form
        className="relative mb-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (draft.trim()) go(draft.trim(), scope)
        }}
      >
        <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="문서 찾기" className="h-12 rounded-xl bg-surface pl-10 text-base" aria-label="문서 찾기" autoFocus={!term} />
      </form>
      {term && (
        <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
          {here && (
            <div className="flex gap-0.5 rounded-lg bg-muted/70 p-0.5" role="tablist" aria-label="찾을 범위">
              {[
                { b: here, label: scopeLabel(site, here) },
                { b: '', label: '모든 묶음' },
              ].map((t) => (
                <button
                  key={t.label}
                  role="tab"
                  aria-selected={scope === t.b}
                  onClick={() => go(term, t.b)}
                  className={cn('rounded-md px-2.5 py-1 transition-colors pointer-coarse:py-2', scope === t.b ? 'bg-background font-medium shadow-[0_1px_2px_rgb(0_0_0/0.08)]' : 'text-muted-foreground hover:text-foreground')}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
          {list && <span className="text-muted-foreground tabular-nums">문서 {list.length}개</span>}
        </div>
      )}
      {term && !list && (
        <div className="space-y-6" aria-label="찾는 중">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2">
              <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
              <div className="h-3 w-full animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      )}
      {list && !list.length && (
        <div className="rounded-xl border border-dashed p-6 text-center">
          <p className="font-medium">「{term}」을 담은 문서가 없습니다.</p>
          <p className="mt-1 text-sm text-muted-foreground">다른 낱말로 찾거나, 이 이름으로 문서를 새로 쓸 수 있습니다.</p>
          <Link className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-link hover:underline" to={`/new?title=${encodeURIComponent(term)}`}>
            「{term}」 문서 쓰기 <ArrowRight className="size-3.5" />
          </Link>
        </div>
      )}
      <ul className="divide-y">
        {list?.map((r) => (
          <li key={r.path}>
            <Link to={pageUrl(r.path)} className="group block py-4">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <KindDot kind={r.kind} />
                {crumbs(r.path).join(' › ') || r.bundle}
              </div>
              <div className="mt-1 text-[17px] font-semibold group-hover:text-link group-hover:underline group-hover:underline-offset-4">
                <Highlight text={r.title} term={term} />
              </div>
              <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                <Highlight text={r.snippet} term={term} />
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── 4. 대문 : 이 묶음의 「대문」(없으면 공통의 대문)을, 둘 다 없으면 차례를 보인다. 최근 바뀜은 늘 아래에 둔다.
// 2026.11.10 : 최근 바뀜이 긴 대문 문서 끝에 묻혀 있었다. 다시 온 사람이 먼저 묻는 것이 「무엇이 바뀌었나」라,
//              넓은 화면에서는 대문 오른쪽(문서 차례 자리)에 붙이고, 좁은 화면만 아래에 둔다.
function RecentRail() {
  return (
    <aside className="sticky top-20 hidden max-h-[calc(100svh-6rem)] w-72 shrink-0 overflow-y-auto xl:block" aria-label="최근 바뀜">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-xs font-medium text-muted-foreground">최근 바뀜</h2>
        <Link to="/changes" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
          모두 보기 →
        </Link>
      </div>
      <ChangeList limit={6} rail />
    </aside>
  )
}

export function Home() {
  const { site } = useSite()
  if (!site) return null
  return (
    <div className="space-y-14">
      {site.front ? (
        <PageView path={site.front} aside={<RecentRail />} />
      ) : (
        <div className="max-w-[72ch]">
          <h1 className="text-3xl font-bold">{site.name}</h1>
          {site.manual.map((g) => (
            <section key={`${g.bundle}/${g.name}`} className="mt-8">
              <h2 className="text-lg font-bold">{g.name || '매뉴얼'}</h2>
              <ul className="mt-2 space-y-1">
                {g.items.map((p) => (
                  <li key={p.path}>
                    <Link to={pageUrl(p.path)} className="text-link hover:underline">
                      {p.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <section className={cn('max-w-[72ch] border-t pt-8', site.front && 'xl:hidden')}>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-bold">최근 바뀜</h2>
          <Link to="/changes" className="text-sm text-muted-foreground hover:text-foreground hover:underline">
            모두 보기 →
          </Link>
        </div>
        <ChangeList limit={6} />
      </section>
    </div>
  )
}
