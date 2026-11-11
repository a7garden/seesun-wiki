import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import rehypeSlug from 'rehype-slug'
import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough'
import { Link } from 'react-router'
import { CornerDownRight } from 'lucide-react'
import { get, pageUrl, q, type LinkMap, type Page } from '@/lib/api'
import { sectionOf, tocHeadings } from '@/lib/headings'
import { WikiLink } from './WikiLink'

// 본문 그리기. 위키만의 표기 세 가지를 마크다운 위에 얹는다.
//   [[제목]] · [[제목|보일 글자]]   링크. 없는 문서는 붉게 · 개념은 마우스를 올리면 요약 카드
//   ![[문서]] · ![[문서#절]]        끼워 넣기(틀). 그 문서 · 그 절을 이 자리에 그린다. 한 줄에 홀로 써야 한다
//   [목차]                          이 자리에 이 문서의 차례(## · ###)를 그린다. 한 줄에 홀로 써야 한다
// 끼운 글은 검색 · 뜻 검색에서 원래 문서에서만 센다(server/src/pages.rs 의 EMBED).
//
// 2026.11.11 마크다운 위에 도식 두 가지를 더했다.
//   ```mermaid … ```                 글로 적은 도식(흐름 · 순서 · 관계). 고치기 쉽고 찾기에도 글로 잡힌다
//   ![설명](/assets/….html "높이")    움직이는 도식(캔버스 애니메이션 · 시뮬레이션). 격리된 틀로 그린다

// ── mermaid : 처음 나올 때만 받는다(크다). 위키 화면을 열 때마다 받으면 첫 화면이 느려진다.
type MermaidApi = { initialize: (c: Record<string, unknown>) => void; render: (id: string, code: string) => Promise<{ svg: string }> }
let mermaidLoad: Promise<MermaidApi> | null = null
let mermaidTheme = ''
async function mermaidFor(dark: boolean) {
  mermaidLoad ??= import('mermaid').then((m) => m.default as unknown as MermaidApi)
  const m = await mermaidLoad
  const theme = dark ? 'dark' : 'neutral'
  if (theme !== mermaidTheme) {
    // strict : 도식 글 안의 html · 누르면 도는 스크립트를 막는다. 누구나 고치는 문서라서다.
    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: 'inherit' })
    mermaidTheme = theme
  }
  return m
}
const isDark = () => document.documentElement.classList.contains('dark')

// 밝은 · 어두운 화면을 바꾸면 도식 색도 다시 그린다 (글로 적은 도식 · 움직이는 도식이 함께 쓴다)
function useDark() {
  const [dark, setDark] = useState(isDark)
  useEffect(() => {
    const o = new MutationObserver(() => setDark(isDark()))
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => o.disconnect()
  }, [])
  return dark
}

function Mermaid({ code }: { code: string }) {
  const id = 'mmd-' + useId().replace(/[^a-zA-Z0-9]/g, '')
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const dark = useDark()
  useEffect(() => {
    let live = true
    mermaidFor(dark)
      .then((m) => m.render(id + (dark ? 'd' : 'l'), code))
      .then((r) => live && (setSvg(r.svg), setError('')))
      .catch((e: Error) => live && setError(e.message || String(e)))
    return () => {
      live = false
    }
  }, [code, dark, id])
  // 글이 틀리면 원문을 그대로 보이고 무엇이 틀렸는지 적는다 — 빈칸으로 두면 고칠 곳을 찾지 못한다
  if (error)
    return (
      <div className="wiki-mermaid-error">
        <p className="text-sm text-destructive">도식을 그리지 못했습니다 : {error.split('\n')[0]}</p>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    )
  if (!svg) return <div className="wiki-mermaid h-24 animate-pulse rounded bg-muted" />
  return <div className="wiki-mermaid" role="img" aria-label="도식" dangerouslySetInnerHTML={{ __html: svg }} />
}

// ── 움직이는 도식 : /assets/….html 을 격리된 틀에 띄운다.
//   sandbox="allow-scripts" (allow-same-origin 없음) : 틀 안 스크립트는 출처가 없어 위키 쿠키 · API 에 닿지 못한다. 서버도 같은 격리를 머리말로 건다.
//   높이 : 본문의 제목 칸("720")이 먼저, 없으면 480. 틀 안 문서가 { type: 'wiki-anim-height', height } 를 보내면 그 높이로 맞춘다.
const isAnim = (src?: string) => typeof src === 'string' && /^\/assets\/[0-9a-f]+\.html(#.*)?$/.test(src)
function Anim({ src, alt, height }: { src: string; alt: string; height?: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [h, setH] = useState(() => Math.min(3000, Math.max(160, Number(height) || 480)))
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return
      const d = e.data as { type?: string; height?: number }
      if (d?.type === 'wiki-anim-height' && Number.isFinite(d.height)) setH(Math.min(3000, Math.max(160, Math.ceil(d.height!))))
    }
    addEventListener('message', on)
    return () => removeEventListener('message', on)
  }, [])
  // 틀 안에 지금 화면 색을 알린다 — 서버가 끼운 스크롤바 스타일이 받아 색을 맞춘다. 틀은 출처가 없어 대상은 '*' 로 준다(색 이름뿐이다)
  const dark = useDark()
  const tell = () => frame.current?.contentWindow?.postMessage({ type: 'wiki-theme', theme: dark ? 'dark' : 'light' }, '*')
  useEffect(tell, [dark])
  return (
    <iframe
      ref={frame}
      onLoad={tell}
      className="wiki-anim"
      src={src}
      title={alt || '움직이는 도식'}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading="lazy"
      style={{ height: h }}
    />
  )
}

// 끼워 넣기가 끝없이 돌지 않게 한다 : 자기 자신 · 위에서 이미 끼운 문서는 다시 끼우지 않고, 3단계까지만 들어간다.
const EMBED_DEPTH = 3
const Trail = createContext<string[]>([])

// [[ ]] 를 마크다운 링크로 바꿔 넘긴다. 코드 블록 안은 그대로 둔다.
//   ![[t#절|l]] → ![l](<wiki:t#절>)  그림 자리를 빌려 끼워 넣기 표시로 쓴다(remarkWikiBlocks 가 받아 블록으로 바꾼다)
//   [[t|l]]     → [l](<wiki:t>)
export function toMarkdown(src: string) {
  return src
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t: string, l?: string) => `![${(l || t).trim()}](<wiki:${t.trim()}>)`)
            .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, t: string, l?: string) => `[${(l || t).trim()}](<wiki:${t.trim()}>)`),
    )
    .join('')
}

export function wikiNames(src: string) {
  return [...src.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim())
}

// 마크다운이 HTML 로 바뀔 때 주소의 한글이 %EA… 로 인코딩된다. 풀지 않으면 이름을 못 찾아 모든 링크가 「없는 문서」가 된다.
function wikiTarget(url: string) {
  try {
    return decodeURIComponent(url.slice(5))
  } catch {
    return url.slice(5)
  }
}

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[]; data?: Record<string, unknown> }

// 문단 하나가 「![[…]]」 하나뿐이거나 「[목차]」 글자뿐이면 그 문단을 블록(div)으로 바꾼다.
// 문단(p) 안에 그리면 끼운 문서의 제목 · 표가 p 안에 들어가 HTML 이 깨진다.
function remarkWikiBlocks() {
  const walk = (n: MdNode) => {
    for (const c of n.children ?? []) {
      if (c.type === 'paragraph' && c.children?.length === 1) {
        const only = c.children[0]
        if (only.type === 'image' && only.url?.startsWith('wiki:')) {
          c.data = { hName: 'div', hProperties: { dataEmbed: wikiTarget(only.url) } }
          c.children = []
          continue
        }
        if (only.type === 'text' && only.value?.trim() === '[목차]') {
          c.data = { hName: 'div', hProperties: { dataToc: '' } }
          c.children = []
          continue
        }
      }
      walk(c)
    }
  }
  return (tree: MdNode) => walk(tree)
}

export function TocList({ body, idPrefix = '' }: { body: string; idPrefix?: string }) {
  const hs = tocHeadings(body)
  if (!hs.length) return null
  return (
    <ul className="space-y-1.5 border-l pl-3">
      {hs.map((h) => (
        <li key={h.id} className={h.depth === 3 ? 'pl-3' : ''}>
          <a href={`#${idPrefix}${h.id}`} className="text-muted-foreground hover:text-foreground">
            {h.text}
          </a>
        </li>
      ))}
    </ul>
  )
}

function Embed({ target, links }: { target: string; links: LinkMap }) {
  const trail = useContext(Trail)
  const [name, part] = [target.split('#')[0].trim(), target.split('#').slice(1).join('#').trim()]
  const hit = links[name]
  const [page, setPage] = useState<Page | null>(null)
  const [failed, setFailed] = useState(false)
  const loop = !!hit && (trail.includes(hit.path) || trail.length >= EMBED_DEPTH)
  useEffect(() => {
    if (!hit || loop) return
    setPage(null)
    setFailed(false)
    get<Page>(`/api/page?${q(hit.path)}`).then(setPage, () => setFailed(true))
  }, [hit?.path, loop])

  // 출처 이름표가 없는 상태(없음 · 불러오는 중)는 위 여백을 따로 준다 — 이름표가 상자 위 테두리에 걸치며 여백을 대신한다.
  const box = (children: ReactNode) => <div className="wiki-embed pt-[.9em]">{children}</div>
  if (!hit)
    return box(
      <p className="text-sm">
        끼울 문서가 없습니다 :{' '}
        <Link className="missing" to={`/new?title=${encodeURIComponent(name)}`}>
          {name}
        </Link>
      </p>,
    )
  if (loop) return box(<p className="text-sm text-muted-foreground">「{hit.title}」은 이미 위에서 끼워 넣어 여기서는 다시 그리지 않습니다.</p>)
  if (failed) return box(<p className="text-sm text-destructive">「{hit.title}」을 불러오지 못했습니다.</p>)
  if (!page) return box(<div className="h-12 animate-pulse rounded bg-muted" />)
  const sec = part ? sectionOf(page.body, part) : { id: '', body: page.body }
  const body = sec?.body ?? null
  return (
    <div className="wiki-embed">
      <div className="wiki-embed-source">
        <CornerDownRight className="size-3 text-muted-foreground" aria-hidden />
        <Link to={pageUrl(page.path) + (sec?.id ? `#${encodeURIComponent(sec.id)}` : '')}>
          {page.title}
          {part ? ` › ${part}` : ''}
        </Link>
      </div>
      {body === null ? (
        <p className="text-sm text-destructive">「{page.title}」에 「{part}」 절이 없습니다.</p>
      ) : (
        <Trail.Provider value={[...trail, page.path]}>
          <Markdown source={body} links={page.links} embedded />
        </Trail.Provider>
      )}
    </div>
  )
}

type HNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HNode[] }

// 책 보기(pages/Book.tsx)는 여러 문서를 한 화면에 잇는다. 제목 id 앞에 장 표지(c2-)를 붙여 장끼리 id 가 겹치지 않게 한다.
// 제목(h1~h6)만 바꾼다 — 각주 id 까지 바꾸면 각주 링크(#user-content-fn-1)가 끊긴다.
const prefixIds = (prefix: string) => () => (tree: HNode) => {
  const walk = (n: HNode) => {
    if (n.type === 'element' && /^h[1-6]$/.test(n.tagName ?? '') && typeof n.properties?.id === 'string') n.properties.id = prefix + n.properties.id
    n.children?.forEach(walk)
  }
  walk(tree)
}

export function Markdown({ source, links, embedded = false, path, idPrefix }: { source: string; links: LinkMap; embedded?: boolean; path?: string; idPrefix?: string }) {
  const trail = useContext(Trail)
  const body = (
    <div className="doc">
      <ReactMarkdown
        // 한국어는 「**범위(모양)**를」처럼 닫는 ** 앞이 문장부호 · 뒤가 조사여서 CommonMark 규칙으로는 굵게가 풀리지 않고 별표가 그대로 보인다.
        // cjk-friendly 가 한중일 글자 옆에서 이 규칙을 풀어 준다. gfm 뒤에 두어야 취소선(~~)까지 덮는다.
        remarkPlugins={[remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough, remarkWikiBlocks]}
        // 끼운 글에는 제목 id 를 달지 않는다. 바깥 문서의 id 와 겹치면 차례가 엉뚱한 제목으로 간다.
        rehypePlugins={embedded ? [] : idPrefix ? [rehypeSlug, prefixIds(idPrefix)] : [rehypeSlug]}
        urlTransform={(url) => (url.startsWith('wiki:') ? url : defaultUrlTransform(url))}
        components={{
          a({ href = '', children }) {
            if (href.startsWith('wiki:')) {
              return (
                <WikiLink name={wikiTarget(href)} links={links}>
                  {children}
                </WikiLink>
              )
            }
            if (href.startsWith('/')) return <Link to={href}>{children}</Link>
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            )
          },
          img({ src, alt, title }) {
            if (isAnim(src)) return <Anim src={src as string} alt={alt || ''} height={title} />
            return <img src={typeof src === 'string' ? src : undefined} alt={alt || ''} loading="lazy" />
          },
          pre(props) {
            // ```mermaid 블록만 도식으로 바꾸고 나머지 코드 블록은 그대로 둔다
            const code = (props.node?.children?.[0] ?? null) as { tagName?: string; properties?: { className?: unknown }; children?: { value?: string }[] } | null
            const cls = code?.tagName === 'code' ? code.properties?.className : null
            if (Array.isArray(cls) && cls.includes('language-mermaid')) {
              return <Mermaid code={(code?.children ?? []).map((c) => c.value ?? '').join('').trim()} />
            }
            const { node: _, ...rest } = props
            return <pre {...rest} />
          },
          div(props) {
            const p = props as Record<string, unknown>
            if (typeof p['data-embed'] === 'string') return <Embed target={p['data-embed']} links={links} />
            if ('data-toc' in p)
              return embedded ? null : (
                <nav className="wiki-toc" aria-label="이 문서의 차례">
                  <div className="wiki-toc-title">목차</div>
                  <TocList body={source} idPrefix={idPrefix} />
                </nav>
              )
            const { node: _, ...rest } = props
            return <div {...rest} />
          },
        }}
      >
        {toMarkdown(source)}
      </ReactMarkdown>
    </div>
  )
  // 맨 바깥 문서는 자기 경로를 끼워 넣기 자취의 첫 칸으로 둔다 — 자기 자신을 끼우면 바로 멈춘다.
  return path && !trail.length ? <Trail.Provider value={[path]}>{body}</Trail.Provider> : body
}
