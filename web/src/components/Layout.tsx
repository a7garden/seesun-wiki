import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { BookOpen, Check, ChevronDown, ChevronRight, ChevronsDownUp, Dices, Menu, Monitor, Moon, Plus, Search, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import { Kbd, PaletteProvider, usePalette } from '@/components/CommandPalette'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { bookUrl, pageUrl, post } from '@/lib/api'
import { scopeOf, useSite } from '@/lib/site'
import { cn } from '@/lib/utils'

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// 차례의 맨 위 줄(대문 등)과 아래 메뉴. quiet 는 아래 메뉴 — 권 트리보다 한 단계 물러나 보인다.
function NavItem({ to, children, onNavigate, quiet = false }: { to: string; children: ReactNode; onNavigate?: () => void; quiet?: boolean }) {
  return (
    <NavLink
      to={to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          // 손가락으로 누르는 화면(차례 서랍)은 줄 높이를 44px 로 넓힌다
          'block rounded-md px-2 py-1.5 transition-colors hover:bg-accent/60 hover:text-foreground pointer-coarse:py-2.5',
          quiet ? 'text-[13px] text-muted-foreground' : 'text-sm text-foreground/80',
          isActive && 'bg-accent/70 font-medium text-foreground',
        )
      }
    >
      {children}
    </NavLink>
  )
}

// 권 안의 장 한 줄. 지금 장은 바탕을 칠하지 않고 안내선 위의 가는 막대 하나로 짚는다 — 줄이 많아도 화면이 조용하다.
function TreeItem({ to, children, onNavigate }: { to: string; children: ReactNode; onNavigate?: () => void }) {
  return (
    <NavLink
      to={to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          // 지금 줄로 스크롤할 때 위에 붙은 권 머리에 가리지 않게 그 높이만큼 띄운다(scroll-mt)
          'relative block scroll-mt-9 rounded-r-md py-[5px] pr-2 pl-3 text-[13px] leading-snug text-foreground/60 transition-colors hover:text-foreground pointer-coarse:py-2.5',
          isActive && 'font-medium text-foreground before:absolute before:inset-y-1 before:-left-px before:w-[2px] before:rounded-full before:bg-primary',
        )
      }
    >
      {children}
    </NavLink>
  )
}

// 차례의 권 하나 (VS Code 탐색기의 폴더처럼)
//   머리 : 스크롤해도 차례 위에 붙어 있어, 보이는 장이 어느 권의 장인지 늘 보인다.
//          오른쪽 끝 한 칸은 접혔을 때 장 수, 가리키면 「책으로 보기」 — 권마다 아이콘이 늘 서 있으면 차례가 시끄럽다.
//   장   : 왼쪽 가는 안내선 안에 든다.
function Group({
  title,
  count,
  open,
  onToggle,
  here,
  book,
  onNavigate,
  children,
}: {
  title: string
  count: number
  open: boolean
  onToggle: () => void
  here: boolean
  book?: string
  onNavigate?: () => void
  children: ReactNode
}) {
  return (
    <div>
      {/* 붙은 머리 아래로 흐림 띠를 둔다 — 밑으로 지나가는 장 글자가 반쯤 잘려 보이지 않게 */}
      <div className="group/head sticky top-0 z-10 flex items-center bg-background after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-3 after:bg-linear-to-b after:from-background after:to-transparent">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 pr-1 pl-1.5 text-left text-[13px] text-foreground/70 transition-colors hover:text-foreground pointer-coarse:py-2.5',
            here && 'font-medium text-foreground',
          )}
        >
          <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 motion-reduce:transition-none', open && 'rotate-90')} />
          <span className="truncate">{title}</span>
        </button>
        <span className="relative grid h-6 w-8 shrink-0 place-items-center">
          {!open && <span className="text-[11px] text-muted-foreground/60 tabular-nums transition-opacity group-focus-within/head:opacity-0 group-hover/head:opacity-0 pointer-coarse:hidden">{count}</span>}
          {book && (
            <Link
              to={book}
              onClick={onNavigate}
              title="책으로 보기"
              aria-label={`「${title}」 책으로 보기`}
              className="absolute inset-0 grid place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/head:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100"
            >
              <BookOpen className="size-3.5" />
            </Link>
          )}
        </span>
      </div>
      {open && <div className="mt-0.5 mb-1.5 ml-[0.85rem] border-l border-border/80">{children}</div>}
    </div>
  )
}

// 권 열림 상태 : 「묶음/권」 → 펼침. 이 브라우저에만 남는 편의라 localStorage 에 둔다(못 쓰면 이 화면 안에서만 기억).
// 손으로 펼치고 접은 것은 다른 문서로 옮겨도 그대로 둔다 — 화면이 마음대로 닫으면 거슬린다.
// 기억이 없는 권은 지금 문서가 든 권만 펼친다. 다만 차례가 짧으면(장이 SHORT_TREE 개 이하) 다 펼친다 — 접을 까닭이 없다.
// 2026.11.10 : 전에는 모든 권이 늘 펼쳐져, 권이 늘면 차례가 수백 줄이 되고 아래 메뉴가 밀려났다.
const OPEN_KEY = 'wiki.toc.open'
const SHORT_TREE = 15

function loadOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveOpen(v: Record<string, boolean>) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(v))
  } catch {
    // 저장소를 못 쓰면 이 화면 안에서만 기억한다
  }
}

// 머리줄의 「위키 / 묶음 ▾」 : 묶음은 찾기 · 개념 · 그래프 범위를 모두 바꾸는 전체 범위라 늘 보이는 머리줄에 둔다.
// 2026.11.10 : 전에는 차례 맨 위의 작은 고르기 칸이라, 좁은 화면에서는 서랍을 열어야 지금 어느 묶음인지 알 수 있었다.
// 고르면 그 묶음의 대문으로 간다.
function BundleCrumb() {
  const { site, setBundle } = useSite()
  const nav = useNavigate()
  if (!site || site.bundles.length < 2) return null
  return (
    <>
      <span className="text-muted-foreground/60" aria-hidden>
        /
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="-ml-1 min-w-0 gap-1 px-2 font-medium" aria-label={`묶음 바꾸기 · 지금 ${site.bundle}`}>
            <span className="truncate">{site.bundle}</span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-auto min-w-44 whitespace-nowrap">
          {site.bundles.map((b) => (
            <DropdownMenuItem
              key={b.name}
              onSelect={() => {
                setBundle(b.name)
                nav('/')
              }}
            >
              {b.name}
              <span className="text-xs text-muted-foreground tabular-nums">{b.count}</span>
              {b.name === site.bundle && <Check className="ml-auto" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

// 차례 : 위는 권 트리(스크롤) · 아래는 다른 화면으로 가는 메뉴(붙박이, VS Code 활동 막대처럼 늘 같은 자리).
function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { site } = useSite()
  const { pathname } = useLocation()
  const [opened, setOpened] = useState(loadOpen)
  const tree = useRef<HTMLDivElement>(null)
  const here = safeDecode(pathname)
  const keyOf = (g: { bundle: string; name: string }) => `${g.bundle}/${g.name}`
  const current = site?.manual.find((g) => g.items.some((p) => safeDecode(pageUrl(p.path)) === here))
  const currentKey = current ? keyOf(current) : ''

  // 지금 문서가 든 권은 접혀 있었어도 펼친다(VS Code 의 Auto Reveal). 펼친 뒤 다시 접는 것은 사용자 몫이다.
  useEffect(() => {
    if (!currentKey) return
    setOpened((o) => {
      if (o[currentKey]) return o
      const next = { ...o, [currentKey]: true }
      saveOpen(next)
      return next
    })
  }, [currentKey])

  // 문서를 열면 차례에서 그 줄이 보이게 스크롤한다. 이미 보이면 움직이지 않는다(nearest).
  useEffect(() => {
    tree.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' })
  }, [here, opened])

  if (!site) return null
  // 개념은 수백 개로 늘어난다. 차례에는 「개념 N」 한 줄과 지금 보는 개념만 둔다.
  // 2026.11.10 : 전에는 가나다 앞의 12개를 펼쳤는데, 그 12개는 아무 판단에도 쓰이지 않고 아래 메뉴만 밀어냈다.
  const concept = site.concepts.find((p) => safeDecode(pageUrl(p.path)) === here)
  // 공유 묶음의 권은 이 묶음의 권 뒤에 「공통 · 권」처럼 묶음 이름을 달고 붙는다. 이 묶음의 권이면 이름만.
  const volumeTitle = (g: { name: string; bundle: string }) => {
    const name = g.name || '매뉴얼'
    return g.bundle === site.bundle ? name : `${g.bundle} · ${name}`
  }
  const short = site.manual.reduce((n, g) => n + g.items.length, 0) <= SHORT_TREE
  const isOpen = (g: { bundle: string; name: string }) => opened[keyOf(g)] ?? (short || keyOf(g) === currentKey)
  const toggle = (g: { bundle: string; name: string }) => {
    const next = { ...opened, [keyOf(g)]: !isOpen(g) }
    setOpened(next)
    saveOpen(next)
  }
  const collapseAll = () => {
    const next = { ...opened, ...Object.fromEntries(site.manual.map((g) => [keyOf(g), false])) }
    setOpened(next)
    saveOpen(next)
  }
  const anyOpen = site.manual.some(isOpen)
  return (
    <nav className="flex h-full min-h-0 flex-col text-sm" aria-label="차례">
      {/* 트리 아래 끝은 흐려지며 사라진다 — 붙박이 메뉴 위에서 줄이 뚝 끊기지 않게. 끝까지 내리면 pb 만큼 비어 마지막 줄은 또렷하다 */}
      <div ref={tree} className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pb-6 [mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]">
        {site.others.length > 0 && (
          <div className="space-y-0.5">
            {site.others.map((p) => (
              <NavItem key={p.path} to={pageUrl(p.path)} onNavigate={onNavigate}>
                {p.title}
              </NavItem>
            ))}
          </div>
        )}
        {site.manual.length > 0 && (
          <div className="group/tree">
            {/* 이름표 줄 : 「모두 접기」는 트리를 가리킬 때만 드러난다(권이 둘 이상이고 펼친 권이 있을 때) */}
            <div className="flex h-7 items-center justify-between pr-1 pl-2 text-[11px] font-medium tracking-wide text-muted-foreground/70">
              <span>매뉴얼</span>
              {site.manual.length > 1 && anyOpen && (
                <button
                  type="button"
                  onClick={collapseAll}
                  title="권 모두 접기"
                  aria-label="권 모두 접기"
                  className="grid size-6 place-items-center rounded-md opacity-0 transition-opacity group-hover/tree:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100"
                >
                  <ChevronsDownUp className="size-3.5" />
                </button>
              )}
            </div>
            {site.manual.map((g) => (
              <Group
                key={keyOf(g)}
                title={volumeTitle(g)}
                count={g.items.length}
                open={isOpen(g)}
                onToggle={() => toggle(g)}
                here={keyOf(g) === currentKey}
                book={g.items.length > 0 ? bookUrl(g.bundle, g.name) : undefined}
                onNavigate={onNavigate}
              >
                {g.items.map((p) => (
                  <TreeItem key={p.path} to={pageUrl(p.path)} onNavigate={onNavigate}>
                    {p.title}
                  </TreeItem>
                ))}
                {/* 「묶음과 권」에서 막 만든 권 : 문서가 없어도 차례에 보이고, 첫 문서를 쓸 자리를 둔다 */}
                {g.items.length === 0 && (
                  <p className="py-1.5 pl-3 text-xs text-muted-foreground">
                    아직 문서가 없습니다.
                    {site.user && (
                      <Link
                        to={`/new?bundle=${encodeURIComponent(g.bundle)}&kind=${encodeURIComponent('매뉴얼')}&group=${encodeURIComponent(g.name)}`}
                        onClick={onNavigate}
                        className="ml-1 text-link underline underline-offset-4"
                      >
                        첫 문서 쓰기
                      </Link>
                    )}
                  </p>
                )}
              </Group>
            ))}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-border/70 pt-3">
        <NavItem to="/concepts" onNavigate={onNavigate} quiet>
          개념 <span className="text-muted-foreground/60 tabular-nums">{site.concepts.length}</span>
        </NavItem>
        {concept && (
          <NavItem to={pageUrl(concept.path)} onNavigate={onNavigate} quiet>
            <span className="block truncate pl-3">{concept.title}</span>
          </NavItem>
        )}
        <NavItem to="/books" onNavigate={onNavigate} quiet>
          책장
        </NavItem>
        <NavItem to="/graph" onNavigate={onNavigate} quiet>
          그래프
        </NavItem>
        <NavItem to="/changes" onNavigate={onNavigate} quiet>
          최근 바뀜
        </NavItem>
        <NavItem to="/bundles" onNavigate={onNavigate} quiet>
          묶음과 권
        </NavItem>
      </div>
    </nav>
  )
}

const THEMES = [
  { value: 'light', label: '밝게', icon: Sun },
  { value: 'dark', label: '어둡게', icon: Moon },
  { value: 'system', label: '시스템 설정 따르기', icon: Monitor },
] as const

function ThemeMenu() {
  const { theme, setTheme, resolvedTheme } = useTheme()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="화면 밝기">
          {resolvedTheme === 'dark' ? <Moon /> : <Sun />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto whitespace-nowrap">
        {THEMES.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem key={value} onSelect={() => setTheme(value)}>
            <Icon /> {label}
            {theme === value && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function UserMenu() {
  const { site, reload } = useSite()
  const nav = useNavigate()
  const loc = useLocation()
  if (!site) return null
  if (!site.user) {
    return (
      <Button variant="ghost" size="sm" asChild>
        <Link to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`}>로그인</Link>
      </Button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">
          <span className="font-mono">{site.user.tag}</span>
        </Button>
      </DropdownMenuTrigger>
      {/* 메뉴 폭은 기본으로 단추 폭을 따른다. 단추가 계정 태그 몇 글자뿐이라 그대로 두면 「내 계정 · MCP 토큰」이 글자마다 꺾인다. */}
      <DropdownMenuContent align="end" className="w-auto whitespace-nowrap">
        <DropdownMenuItem onSelect={() => nav('/account')}>내 계정 · MCP 토큰</DropdownMenuItem>
        {site.user.role === 'admin' && <DropdownMenuItem onSelect={() => nav('/admin')}>관리</DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => {
            await post('/api/logout', {})
            await reload()
          }}
        >
          로그아웃
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// 머리줄의 찾기 : 칸처럼 보이는 단추. 누르거나 Ctrl+K · / 를 치면 명령 팔레트가 열린다.
function SearchTrigger() {
  const { site } = useSite()
  const { open } = usePalette()
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  const scope = scopeOf(site)
  return (
    <>
      <button
        type="button"
        onClick={open}
        className="ml-auto hidden h-9 w-full max-w-xs items-center gap-2 rounded-lg border bg-surface px-2.5 text-sm text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:flex"
      >
        <Search className="size-4" />
        <span className="truncate">{scope ? `${scope}에서 찾기` : '문서 찾기'}</span>
        <span className="ml-auto flex gap-0.5">
          <Kbd>{mac ? '⌘' : 'Ctrl'}</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
      <Button variant="ghost" size="icon" className="ml-auto size-10 sm:hidden" aria-label="문서 찾기" onClick={open}>
        <Search />
      </Button>
    </>
  )
}

// 머리줄의 주사위 : 무엇을 읽을지 모를 때 개념 하나를 아무거나 연다.
// 고르는 범위는 차례의 「개념 N」과 같다(이 묶음과 공유 묶음). 지금 보는 개념은 빼고 고른다 — 같은 문서가 다시 나오면 눌러도 안 바뀐 듯 보인다.
// 단축키 R : 찾기의 / 처럼 글을 쓰는 칸 밖에서만 듣는다. 그러지 않으면 편집 화면에서 r 을 칠 때마다 다른 문서로 튄다.
function RandomConcept() {
  const { site } = useSite()
  const nav = useNavigate()
  const { pathname } = useLocation()
  const roll = () => {
    if (!site || site.concepts.length === 0) return
    const here = safeDecode(pathname)
    const others = site.concepts.filter((p) => safeDecode(pageUrl(p.path)) !== here)
    const pool = others.length ? others : site.concepts
    const pick = pool[Math.floor(Math.random() * pool.length)]
    nav(pageUrl(pick.path))
  }
  // 듣개는 한 번만 달고, 누를 때는 늘 지금 화면의 roll 을 부른다(지금 문서를 빼려면 최신 pathname 이 필요하다)
  const latest = useRef(roll)
  latest.current = roll
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))
      if ((e.key === 'r' || e.key === 'R') && !typing && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.defaultPrevented) {
        e.preventDefault()
        latest.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  if (!site || site.concepts.length === 0) return null
  return (
    <Button variant="ghost" size="icon" onClick={roll} title="아무 개념이나 읽기 (R)" aria-label="아무 개념이나 읽기" aria-keyshortcuts="R">
      <Dices />
    </Button>
  )
}

export function Layout() {
  return (
    <PaletteProvider>
      <Shell />
    </PaletteProvider>
  )
}

function Shell() {
  const { site } = useSite()
  const [open, setOpen] = useState(false)
  return (
    <div className="min-h-svh">
      {/* 키보드로 쓰면 왼쪽 차례 수십 줄을 지나야 본문에 닿는다. 첫 Tab 에 나타나는 건너뛰기 링크 */}
      <a href="#main" className="fixed top-2 left-2 z-50 print:hidden -translate-y-16 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-transform focus:translate-y-0">
        본문으로 건너뛰기
      </a>
      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur print:hidden">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-2 px-4">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="size-10 lg:hidden" aria-label="차례 열기">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="flex w-72 flex-col p-4">
              <SheetTitle className="mb-3">{site?.name}</SheetTitle>
              <div className="min-h-0 flex-1">
                <Sidebar onNavigate={() => setOpen(false)} />
              </div>
            </SheetContent>
          </Sheet>
          <div className="mr-2 flex min-w-0 items-center gap-1.5">
            <Link to="/" className="shrink-0 font-semibold">
              {site?.name ?? '위키'}
            </Link>
            <BundleCrumb />
          </div>
          <SearchTrigger />
          <RandomConcept />
          {site?.user && (
            <Button size="sm" variant="outline" asChild>
              <Link to="/new">
                <Plus /> <span className="hidden sm:inline">새 문서</span>
              </Link>
            </Button>
          )}
          <ThemeMenu />
          <UserMenu />
        </div>
      </header>
      <div className="mx-auto flex max-w-[1400px] gap-8 px-4">
        <aside className="sticky top-14 hidden h-[calc(100svh-3.5rem)] w-64 shrink-0 py-6 lg:block print:hidden">
          <Sidebar />
        </aside>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 py-8 outline-none print:py-0">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
