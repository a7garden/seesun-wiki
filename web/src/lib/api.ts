// 위키 서버 API. 쓰기 요청에는 x-wiki 머리글을 붙인다(서버가 다른 사이트의 몰래 쓰기를 막는 표지).

export type Kind = 'concept' | 'manual' | 'page'

export interface Brief {
  path: string
  bundle: string
  title: string
  kind: Kind
  summary: string
  image: string | null
  aliases: string[]
  order: number
}

// 이름 · 이메일은 받지 않는다. 화면 · 이력에는 tag(계정 해시)만 보인다 — server/src/auth.rs 머리말.
export interface User {
  id: string
  tag: string
  org: string
  role: 'admin' | 'editor'
}

export interface Site {
  name: string
  user: User | null
  openSignup: boolean
  orgs: string[]
  needsSetup: boolean
  bundle: string // 지금 보는 묶음
  bundles: { name: string; count: number; shared: boolean; about: string }[]
  shared: string[] // 공유 묶음 : 어느 묶음을 보든 함께 보인다
  front: string | null // 대문으로 보일 문서 : <묶음>/대문, 없으면 공유 묶음의 대문
  manual: { name: string; bundle: string; about: string; items: Brief[] }[] // 이 묶음의 권, 그 뒤에 공유 묶음의 권
  concepts: Brief[] // 이 묶음과 공유 묶음의 개념
  others: Brief[] // 이 묶음의 일반 문서
  mcpUrl: string
}

export type LinkMap = Record<string, { path: string; title: string; kind: Kind } | null>

export interface Page extends Brief {
  meta: Record<string, unknown>
  body: string
  commit: string | null
  updated: { author: string; date: string } | null
  links: LinkMap
  backlinks: Brief[]
}

export interface Change {
  status: 'A' | 'M' | 'D' | 'R' | string // 새로 씀 · 고침 · 지움 · 옮김
  path: string
  from?: string // 옮긴 문서의 옛 경로
}

export interface Commit {
  hash: string
  author: string
  email: string
  date: string
  subject: string
  files: string[]
  changes?: Change[] // 최근 바뀜에만 온다
  added?: number // 문서 이력에만 온다 : 그 판에서 더한 줄 · 뺀 줄
  removed?: number
}

export class ApiError extends Error {
  status: number
  data: Record<string, unknown>
  constructor(status: number, data: Record<string, unknown>) {
    super(String(data.error || '요청을 처리하지 못했습니다'))
    this.status = status
    this.data = data
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: 'same-origin', ...init })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(r.status, data)
  return data as T
}

export const get = <T,>(url: string) => request<T>(url)

export const post = <T,>(url: string, body: unknown) =>
  request<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wiki': '1' },
    body: JSON.stringify(body),
  })

export const uploadImage = (file: Blob) =>
  request<{ url: string }>('/api/assets', {
    method: 'POST',
    headers: { 'content-type': file.type, 'x-wiki': '1' },
    body: file,
  })

export const q = (path: string) => `path=${encodeURIComponent(path)}`

// 화면 주소 : /w/산사태/개념/계류 처럼 경로를 그대로 쓴다. 조각마다 인코딩해 / 는 남긴다.
export const pageUrl = (path: string, prefix = '/w') => `${prefix}/${path.split('/').map(encodeURIComponent).join('/')}`

// 책 보기 주소 : /book/<묶음>/<권>. 권 없이 매뉴얼 바로 아래 둔 문서들은 /book/<묶음>.
export const bookUrl = (bundle: string, volume: string) => pageUrl(volume ? `${bundle}/${volume}` : bundle, '/book')

export function when(iso: string) {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 「3시간 전」처럼 지금에서 얼마나 지났는지. 일주일이 넘으면 날짜로 쓴다 — 오래된 판은 상대 시각이 오히려 헷갈린다.
export function ago(iso: string, now = Date.now()) {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000)
  if (s < 60) return '방금'
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}일 전`
  return when(iso).slice(0, 10)
}

// 날짜 묶음 이름 : 오늘 · 어제 · 11월 7일 (금)
export function dayLabel(iso: string, now = new Date()) {
  const d = new Date(iso)
  const key = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (key(d) === key(now)) return '오늘'
  if (key(d) === key(y)) return '어제'
  const head = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}년 `
  return `${head}${d.getMonth() + 1}월 ${d.getDate()}일 (${'일월화수목금토'[d.getDay()]})`
}

export const KIND_NAME: Record<Kind, string> = { concept: '개념', manual: '매뉴얼', page: '일반' }

// 경로를 사람이 읽는 길로 : 산사태/매뉴얼/사전검토 업무/접수 → [산사태, 사전검토 업무]
export function crumbs(path: string) {
  const [bundle, kind, ...rest] = path.split('/')
  if (!kind) return [] as string[]
  const middle = kind === '매뉴얼' ? rest.slice(0, -1) : kind === '개념' ? ['개념'] : []
  return [bundle, ...middle]
}
