import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { FilePlus2 } from 'lucide-react'
import { KindDot } from '@/components/Marks'
import { crumbs, type Brief } from '@/lib/api'
import { useSite } from '@/lib/site'
import { cn } from '@/lib/utils'

// 편집 칸의 [[ 자동완성. [[ 를 치면 커서 바로 아래에 문서 이름 후보가 뜬다.
// 2026.11.09 : 이 위키는 링크로 짜인 글인데, 링크를 쓰려면 문서 이름을 정확히 외워야 했다(틀리면 붉은 「없는 문서」가 된다).
//   ↑↓ 고르기 · Enter/Tab 넣기 · Esc 닫기. 후보에 없으면 「새 문서」로 친 글자 그대로 넣는다.
//   한글은 조합 중에 Enter 가 글자를 마무리하는 키라, 조합 중인 키는 건드리지 않는다.

const MAX = 8

/** textarea 안 글자 위치의 화면 좌표. 같은 글꼴 · 폭의 보이지 않는 거울 칸에 글을 옮겨 적어 잰다. */
function caretXY(el: HTMLTextAreaElement, pos: number) {
  const cs = getComputedStyle(el)
  const m = document.createElement('div')
  for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'boxSizing', 'wordBreak', 'overflowWrap', 'tabSize'] as const)
    m.style[k] = cs[k]
  Object.assign(m.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', width: `${el.clientWidth}px`, top: '0', left: '-9999px' })
  m.textContent = el.value.slice(0, pos)
  const mark = document.createElement('span')
  mark.textContent = '​'
  m.appendChild(mark)
  document.body.appendChild(m)
  const xy = { left: mark.offsetLeft, top: mark.offsetTop + parseFloat(cs.lineHeight || '20') - el.scrollTop }
  m.remove()
  return xy
}

type Option = { key: string; title: string; brief?: Brief }

export function LinkComplete({ area, setBody }: { area: RefObject<HTMLTextAreaElement | null>; setBody: (fn: (b: string) => string) => void }) {
  const { site } = useSite()
  const [query, setQuery] = useState<string | null>(null)
  const [start, setStart] = useState(0)
  const [xy, setXY] = useState({ left: 0, top: 0 })
  const [active, setActive] = useState(0)
  const state = useRef({ open: false, options: [] as Option[], active: 0, start: 0 })
  const chooseRef = useRef<(o: Option) => void>(() => {})

  const all = useMemo(() => {
    if (!site) return [] as Brief[]
    const seen = new Set<string>()
    return [...site.concepts, ...site.manual.flatMap((g) => g.items), ...site.others].filter((b) => !seen.has(b.title) && seen.add(b.title))
  }, [site])

  const options = useMemo<Option[]>(() => {
    if (query === null) return []
    const t = query.trim().toLowerCase()
    const hit = all
      .filter((b) => !t || b.title.toLowerCase().includes(t) || b.aliases.some((a) => a.toLowerCase().includes(t)))
      .sort((a, b) => Number(!a.title.toLowerCase().startsWith(t)) - Number(!b.title.toLowerCase().startsWith(t)) || a.title.length - b.title.length)
      .slice(0, MAX)
      .map((b): Option => ({ key: b.path, title: b.title, brief: b }))
    if (t && !hit.some((o) => o.title.toLowerCase() === t)) hit.push({ key: '#new', title: query.trim() })
    return hit
  }, [query, all])

  const open = query !== null && options.length > 0
  useEffect(() => {
    state.current = { open, options, active, start }
  })

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    const el = area.current
    if (!el) return
    const sense = () => {
      const pos = el.selectionStart
      if (pos !== el.selectionEnd) return setQuery(null)
      const before = el.value.slice(Math.max(0, pos - 60), pos)
      const m = before.match(/\[\[([^\]\n|#]{0,40})$/)
      if (!m) return setQuery(null)
      setQuery(m[1])
      setStart(pos - m[1].length)
      const p = caretXY(el, pos - m[1].length)
      setXY({ left: Math.min(p.left, el.clientWidth - 288), top: p.top })
    }
    const choose = (o: Option) => {
      const { start: s } = state.current
      const pos = el.selectionStart
      const after = el.value.slice(pos)
      const close = after.startsWith(']]') ? '' : ']]'
      const text = o.title + close
      setBody((b) => b.slice(0, s) + text + b.slice(pos))
      setQuery(null)
      requestAnimationFrame(() => {
        el.focus()
        const at = s + o.title.length + 2
        el.setSelectionRange(at, at)
      })
    }
    const onKey = (e: KeyboardEvent) => {
      const st = state.current
      if (!st.open || e.isComposing) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const n = st.options.length
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        choose(st.options[st.active])
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setQuery(null)
      }
    }
    const onBlur = () => setTimeout(() => setQuery(null), 120)
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') sense()
    }
    const onScroll = () => setQuery(null)
    el.addEventListener('input', sense)
    el.addEventListener('click', sense)
    el.addEventListener('keyup', onKeyUp)
    el.addEventListener('keydown', onKey)
    el.addEventListener('blur', onBlur)
    el.addEventListener('scroll', onScroll)
    chooseRef.current = choose
    return () => {
      el.removeEventListener('input', sense)
      el.removeEventListener('click', sense)
      el.removeEventListener('keyup', onKeyUp)
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('blur', onBlur)
      el.removeEventListener('scroll', onScroll)
    }
  }, [area, setBody])

  if (!open) return null
  const choose = (o: Option) => chooseRef.current(o)
  return (
    <div
      role="listbox"
      aria-label="잇을 문서"
      className="absolute z-20 w-72 overflow-hidden rounded-lg border bg-popover p-1 text-sm shadow-[0_12px_32px_-12px_rgb(0_0_0/0.3)]"
      style={{ left: Math.max(0, xy.left), top: xy.top + 4 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {options.map((o, i) => (
        <div
          key={o.key}
          role="option"
          aria-selected={i === active}
          onMouseMove={() => setActive(i)}
          onClick={() => choose(o)}
          className={cn('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5', i === active && 'bg-accent')}
        >
          {o.brief ? <KindDot kind={o.brief.kind} /> : <FilePlus2 className="size-3.5 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate">{o.brief ? o.title : `새 문서 「${o.title}」`}</span>
          {o.brief && <span className="shrink-0 text-[11px] text-muted-foreground">{crumbs(o.brief.path).at(-1)}</span>}
        </div>
      ))}
      <p className="border-t px-2 pt-1.5 pb-0.5 text-[11px] text-muted-foreground">Enter 넣기 · Esc 닫기</p>
    </div>
  )
}
