import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { ArrowRight, CornerDownLeft, FilePlus2, History, Network, Search, Shapes } from 'lucide-react'
import { KindDot } from '@/components/Marks'
import { crumbs, get, pageUrl, type Brief } from '@/lib/api'
import { scopeLabel, scopeOf, useSite } from '@/lib/site'
import { cn } from '@/lib/utils'

// 명령 팔레트 : Ctrl+K (맥은 ⌘K) · / 로 어디서나 연다.
// 2026.11.09 : 머리줄의 찾기 칸은 Enter 를 눌러야 결과 화면으로 넘어갔다. 쓰는 대로 결과가 뜨고, 고르면 바로 문서로 간다.
//   1. 제목 · 다른 이름은 이미 받아 둔 차례(site)에서 바로 고른다 — 한 글자부터 기다림 없이 뜬다.
//   2. 본문은 서버 찾기(/api/search)로 잠시 뒤 덧붙인다. 같은 문서는 한 줄로 합친다.
//   3. 맨 아래 「모든 결과 보기」 · 「새 문서로 쓰기」. 아무것도 안 쳤으면 자주 가는 화면을 보인다.

type Hit = { path: string; title: string; kind: Brief['kind']; snippet?: string; alias?: string }
type Item = { key: string; label: ReactNode; hint?: ReactNode; icon: ReactNode; run: () => void }

const Ctx = createContext<{ open: () => void }>({ open: () => {} })
export const usePalette = () => useContext(Ctx)

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 찾은 낱말을 <mark> 로 감싼다. 띄어 쓴 낱말은 하나씩 찾는다. */
export function Highlight({ text, term }: { text: string; term: string }) {
  const words = term.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return <>{text}</>
  const re = new RegExp(`(${words.map(esc).join('|')})`, 'gi')
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="hit">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  )
}

function Palette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { site } = useSite()
  const nav = useNavigate()
  const [term, setTerm] = useState('')
  const [remote, setRemote] = useState<(Brief & { snippet: string })[]>([])
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const scope = scopeOf(site)

  useEffect(() => {
    if (!open) {
      setTerm('')
      setRemote([])
    }
  }, [open])

  // 본문 찾기는 치는 동안 매번 부르지 않고 잠깐 멈췄을 때 부른다.
  useEffect(() => {
    const t = term.trim()
    if (!t) return setRemote([])
    const id = setTimeout(() => {
      get<(Brief & { snippet: string })[]>(`/api/search?q=${encodeURIComponent(t)}${scope ? `&b=${encodeURIComponent(scope)}` : ''}`).then(setRemote, () => setRemote([]))
    }, 160)
    return () => clearTimeout(id)
  }, [term, scope])

  const hits = useMemo<Hit[]>(() => {
    const t = term.trim().toLowerCase()
    if (!t || !site) return []
    const all = [...site.others, ...site.manual.flatMap((g) => g.items), ...site.concepts]
    const local: Hit[] = []
    for (const b of all) {
      const alias = b.aliases.find((a) => a.toLowerCase().includes(t))
      if (b.title.toLowerCase().includes(t) || alias) local.push({ path: b.path, title: b.title, kind: b.kind, alias: b.title.toLowerCase().includes(t) ? undefined : alias })
    }
    // 제목이 친 글자로 시작하는 것을 앞에
    local.sort((a, b) => Number(!a.title.toLowerCase().startsWith(t)) - Number(!b.title.toLowerCase().startsWith(t)) || a.title.length - b.title.length)
    const seen = new Map(local.map((h) => [h.path, h]))
    for (const r of remote) {
      const had = seen.get(r.path)
      if (had) had.snippet = r.snippet
      else {
        const h = { path: r.path, title: r.title, kind: r.kind, snippet: r.snippet }
        seen.set(r.path, h)
        local.push(h)
      }
    }
    return local.slice(0, 30)
  }, [term, site, remote])

  const go = useCallback(
    (to: string) => {
      onOpenChange(false)
      nav(to)
    },
    [nav, onOpenChange],
  )

  const items = useMemo<Item[]>(() => {
    const t = term.trim()
    if (!t)
      return [
        { key: 'concepts', label: '모든 개념', icon: <Shapes />, run: () => go('/concepts') },
        { key: 'graph', label: '문서 그래프', icon: <Network />, run: () => go('/graph') },
        { key: 'changes', label: '최근 바뀜', icon: <History />, run: () => go('/changes') },
      ]
    const out: Item[] = hits.map((h) => ({
      key: h.path,
      icon: <KindDot kind={h.kind} className="size-2.5" />,
      label: (
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-medium">
              <Highlight text={h.title} term={t} />
            </span>
            {h.alias && (
              <span className="shrink-0 text-xs text-muted-foreground">
                = <Highlight text={h.alias} term={t} />
              </span>
            )}
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{crumbs(h.path).join(' › ')}</span>
          </span>
          {h.snippet && (
            <span className="mt-0.5 line-clamp-1 text-[13px] text-muted-foreground">
              <Highlight text={h.snippet} term={t} />
            </span>
          )}
        </span>
      ),
      run: () => go(pageUrl(h.path)),
    }))
    out.push({
      key: '#all',
      icon: <Search />,
      label: <span>「{t}」 모든 결과 보기</span>,
      run: () => go(`/search?q=${encodeURIComponent(t)}${scope ? `&b=${encodeURIComponent(scope)}` : ''}`),
    })
    if (site?.user && !hits.some((h) => h.title === t))
      out.push({ key: '#new', icon: <FilePlus2 />, label: <span>「{t}」 새 문서로 쓰기</span>, run: () => go(`/new?title=${encodeURIComponent(t)}`) })
    return out
  }, [term, hits, go, scope, site?.user])

  useEffect(() => setActive(0), [term])
  useEffect(() => {
    list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  function onKey(e: React.KeyboardEvent) {
    if (e.nativeEvent.isComposing) return // 한글 조합 중의 Enter 는 글자를 마무리하는 키다
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(items.length - 1, a + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      items[active]?.run()
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/15 backdrop-blur-[2px] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          className="fixed top-[12svh] left-1/2 z-50 flex max-h-[min(34rem,76svh)] w-[min(40rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-[0_24px_60px_-20px_rgb(0_0_0/0.35)] outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0"
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="sr-only">문서 찾기</DialogPrimitive.Title>
          <div className="flex items-center gap-2.5 border-b px-4">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={onKey}
              placeholder={scope ? `${scopeLabel(site, scope)}에서 문서 찾기` : '문서 찾기'}
              className="h-13 w-full bg-transparent text-base outline-none placeholder:text-muted-foreground"
              role="combobox"
              aria-expanded
              aria-controls="palette-list"
              aria-activedescendant={items[active] ? `palette-${active}` : undefined}
              aria-label="문서 찾기"
            />
          </div>
          <div ref={list} id="palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {!term.trim() && <p className="px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground">바로 가기</p>}
            {items.map((it, i) => (
              <div
                key={it.key}
                id={`palette-${i}`}
                data-i={i}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => setActive(i)}
                onClick={it.run}
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
                  i === active && 'bg-accent',
                )}
              >
                <span className="grid w-4 place-items-center">{it.icon}</span>
                <span className="min-w-0 flex-1">{it.label}</span>
                {i === active && <ArrowRight className="opacity-60" />}
              </div>
            ))}
          </div>
          <div className="hidden items-center gap-3 border-t px-4 py-2 text-xs text-muted-foreground sm:flex">
            <span className="inline-flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> 고르기
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>
                <CornerDownLeft className="size-3" />
              </Kbd>{' '}
              열기
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Esc</Kbd> 닫기
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded border bg-background px-1 font-sans text-[11px] text-muted-foreground', className)}>{children}</kbd>
}

export function PaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))
      if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      } else if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const value = useMemo(() => ({ open: () => setOpen(true) }), [])
  return (
    <Ctx.Provider value={value}>
      {children}
      <Palette open={open} onOpenChange={setOpen} />
    </Ctx.Provider>
  )
}
