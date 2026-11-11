import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { get, type Site } from './api'

// 위키 묶음(산사태 · 공통 …) : 왼쪽 차례 · 개념 모음 · 검색 · 그래프가 고른 묶음과 공유 묶음만 보인다.
// 문서를 열면 그 문서의 묶음으로 바뀐다. 공유 묶음 문서는 어느 묶음에서나 함께 보이므로 열어도 묶음을 바꾸지 않는다
// — 바꾸면 「위키 사용법」을 읽는 동안 차례에서 내 분야 문서가 사라진다.
// 2026.11.10 : 공유 묶음은 「공통」 하나로 박혀 있던 것을 서버의 묶음 목록(site.shared)에서 받는다. 「묶음과 권」 화면에서 정한다.
const KEY = 'wiki-bundle'
const SHARED_KEY = 'wiki-shared'
const DOC_ROUTE = /^\/(?:w|edit|history|rev|diff)\/([^/]+)\/|^\/book\/([^/]+)/

function remembered() {
  try {
    return localStorage.getItem(KEY) || ''
  } catch {
    return ''
  }
}
// 주소에서 묶음을 읽을 때 공유 묶음인지 알아야 한다. 사이트 정보를 받기 전(처음 열 때)에도 쓰므로 지난번 값을 기억해 둔다.
let sharedKnown: string[] = (() => {
  try {
    return JSON.parse(localStorage.getItem(SHARED_KEY) || '[]') as string[]
  } catch {
    return []
  }
})()
function rememberShared(list: string[]) {
  sharedKnown = list
  try {
    localStorage.setItem(SHARED_KEY, JSON.stringify(list))
  } catch {
    // 저장소를 막은 브라우저 : 이번 창에서만 기억한다
  }
}

/** 목록 · 검색 · 그래프를 좁힐 묶음. 지금 묶음이 공유 묶음이면 빈 글(위키 전체). */
export function scopeOf(site: Site | null) {
  return site && !site.shared.includes(site.bundle) ? site.bundle : ''
}
/** 「산사태 · 공통」 : 그 묶음과 공유 묶음 이름. */
export function scopeLabel(site: Site | null, b: string) {
  return [b, ...(site?.shared ?? [])].join(' · ')
}

function remember(b: string) {
  try {
    localStorage.setItem(KEY, b)
  } catch {
    // 저장소를 막은 브라우저 : 다음에 열 때 기본 묶음으로 시작할 뿐이다
  }
}

/** 주소가 가리키는 묶음. 문서 주소가 아니거나 공유 묶음 문서면 null. */
function bundleInUrl(pathname: string, search: string) {
  const m = pathname.match(DOC_ROUTE)
  if (m) {
    let b = m[1] ?? m[2]
    try {
      b = decodeURIComponent(b)
    } catch {
      // 깨진 주소는 그대로 둔다
    }
    return sharedKnown.includes(b) ? null : b
  }
  return new URLSearchParams(search).get('b')
}

export const bundleOf = (path: string) => (path.includes('/') ? path.split('/')[0] : '')

interface SiteState {
  site: Site | null
  reload: () => Promise<void>
  setBundle: (b: string) => void
}

const Ctx = createContext<SiteState>({ site: null, reload: async () => {}, setBundle: () => {} })

export function SiteProvider({ children }: { children: ReactNode }) {
  const { pathname, search } = useLocation()
  const [site, setSite] = useState<Site | null>(null)
  const [wanted, setWanted] = useState(() => bundleInUrl(pathname, search) || remembered())
  const latest = useRef(wanted)

  useEffect(() => {
    const b = bundleInUrl(pathname, search)
    if (b) setWanted(b)
  }, [pathname, search])

  const reload = useCallback(async () => {
    const b = latest.current
    const s = await get<Site>(`/api/site${b ? `?b=${encodeURIComponent(b)}` : ''}`)
    // 받는 사이 다른 묶음을 골랐으면 늦게 온 응답은 버린다
    if (b !== latest.current) return
    rememberShared(s.shared)
    setSite(s)
    remember(s.bundle)
  }, [])

  useEffect(() => {
    latest.current = wanted
    reload()
  }, [wanted, reload])

  return <Ctx.Provider value={{ site, reload, setBundle: setWanted }}>{children}</Ctx.Provider>
}

export const useSite = () => useContext(Ctx)
