import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import ForceGraph from 'force-graph'
import { ArrowRight, Maximize, Minus, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// 문서 그래프 캔버스 : 점 하나가 문서, 선 하나가 [[링크]]. 「그래프」 화면과 문서 화면의 작은 그래프 칸이 함께 쓴다.
//
// 목차
//   1. 자료 꼴 · 둘레 고르기(around · makeView)
//   2. 색 읽기 · 섞기 · 배율 맞추기
//   3. GraphCanvas — 강조 세기 정하기 · 점 · 선 그리기 · 가리킴 · 고정 · Esc
//   4. 데이터 바꾸기 · 고정 카드 · 확대 단추
//
// 강조는 셋이 겹친다.
//   가리킴 : 마우스를 올린 문서와 그 이웃. 마우스가 떠나도 바로 지우지 않고 잠시 두었다가 서서히 걷는다 —
//            바로 지우면 강조된 이웃을 보려고 마우스를 옮기는 사이에 강조가 사라진다(2026.11.09 사용자 지적).
//   고정   : 점을 누르면 그 문서와 이웃이 강조된 채 남는다. 빈 곳을 누르거나 Esc 로 푼다. 고정된 점을 다시 누르면 문서를 연다.
//   찾기   : 아무것도 가리키지 않을 때만 찾은 문서를 밝힌다.
export type Kind = 'concept' | 'manual' | 'page'
export type GNode = { id: string; title: string; kind: Kind; deg?: number; x?: number; y?: number }
export type GLink = { source: string | GNode; target: string | GNode }
export type Data = { nodes: GNode[]; links: GLink[] }
export type GraphHandle = { centerOn: (id: string) => void }

export const KIND_LABEL: Record<Kind, string> = { concept: '개념', manual: '매뉴얼', page: '일반' }
export const KIND_VAR: Record<Kind, string> = { concept: '--graph-concept', manual: '--graph-manual', page: '--graph-page' }
export const idOf = (v: string | GNode) => (typeof v === 'string' ? v : v.id)
// 점 크기는 링크 수로 키우되 천천히 키운다. 몇몇 중심 문서가 공처럼 커져 둘레를 덮지 않게.
const radius = (n: GNode) => 2.2 + Math.sqrt(n.deg || 0) * 0.9

// 마우스가 떠난 뒤 강조를 그대로 두는 시간 · 걷히는 시간(ms).
const HOLD = 900
const FADE = 700

// 가운데 문서에서 depth 단계 안에 닿는 문서들. 링크 방향은 보지 않는다(가리키는 쪽 · 가리켜지는 쪽 모두 이웃이다).
export function around(data: Data, focus: string, depth: number) {
  const adj = new Map<string, string[]>()
  for (const l of data.links) {
    const a = idOf(l.source), b = idOf(l.target)
    adj.set(a, [...(adj.get(a) || []), b])
    adj.set(b, [...(adj.get(b) || []), a])
  }
  const keep = new Set([focus])
  let edge = [focus]
  for (let d = 0; d < depth; d++) {
    const next: string[] = []
    for (const id of edge) for (const n of adj.get(id) || []) if (!keep.has(n)) { keep.add(n); next.push(n) }
    edge = next
  }
  return keep
}

// 보일 문서 · 선을 고른다. 그래프 라이브러리가 객체에 좌표를 써 넣으므로 매번 새로 만든다.
export function makeView(data: Data, focus: string, depth: number, kinds?: Set<Kind>): Data {
  const near = focus ? around(data, focus, depth) : null
  const nodes = data.nodes.filter((n) => (near ? near.has(n.id) : true) && (!kinds || kinds.has(n.kind) || n.id === focus)).map((n) => ({ ...n, deg: 0 }))
  const ids = new Map(nodes.map((n) => [n.id, n]))
  const links = data.links.filter((l) => ids.has(idOf(l.source)) && ids.has(idOf(l.target))).map((l) => ({ source: idOf(l.source), target: idOf(l.target) }))
  for (const l of links) { ids.get(l.source)!.deg! += 1; ids.get(l.target)!.deg! += 1 }
  return { nodes, links }
}

// 선 색은 걷히는 동안 두 색 사이를 옮겨 가야 한다. CSS 변수는 oklch 라 그대로는 섞을 수 없어 rgb 로 바꿔 둔다.
type RGB = [number, number, number]
let probe: CanvasRenderingContext2D | null = null
function toRgb(c: string): RGB {
  probe ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true })!
  probe.clearRect(0, 0, 1, 1)
  probe.fillStyle = c
  probe.fillRect(0, 0, 1, 1)
  const d = probe.getImageData(0, 0, 1, 1).data
  return [d[0], d[1], d[2]]
}
const mix = (a: RGB, b: RGB, t: number) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

// 캔버스는 CSS 변수를 못 읽으므로 색을 꺼내 둔다. 어두운 화면으로 바뀌면 다시 읽는다.
function readColors() {
  const s = getComputedStyle(document.documentElement)
  const v = (n: string) => s.getPropertyValue(n).trim()
  return {
    kind: { concept: v(KIND_VAR.concept), manual: v(KIND_VAR.manual), page: v(KIND_VAR.page) } as Record<Kind, string>,
    text: v('--foreground'),
    label: v('--graph-label'),
    line: toRgb(v('--graph-line')),
    lineDense: toRgb(v('--graph-line-dense')),
    lineHot: toRgb(v('--graph-line-hot')),
    lineDim: toRgb(v('--graph-line-dim')),
    bg: v('--background'),
  }
}

// 같은 배율로 한 번 다시 그리게 한다. 보이는 것은 바뀌지 않는다.
function redraw(g: ForceGraph<GNode, GLink>) {
  g.zoom(g.zoom())
}

// 모든 점이 보이게 가운데와 배율을 정한다. 문서가 몇 개뿐이면 배율이 너무 커지므로 2 를 넘기지 않는다.
function fit(g: ForceGraph<GNode, GLink>, ms: number) {
  if (!g.graphData().nodes.length) return
  const b = g.getGraphBbox()
  const pad = 40
  const k = Math.min(2, (g.width() - pad * 2) / Math.max(1, b.x[1] - b.x[0]), (g.height() - pad * 2) / Math.max(1, b.y[1] - b.y[0]))
  g.centerAt((b.x[0] + b.x[1]) / 2, (b.y[0] + b.y[1]) / 2, ms)
  g.zoom(k, ms)
}

export function GraphCanvas({
  view,
  focus = '',
  matches,
  highlight = null,
  compact = false,
  onOpen,
  ref,
}: {
  view: Data | null
  focus?: string
  matches?: Set<string>
  /** 캔버스 밖(이웃 목록)에서 가리킨 문서. 마우스를 올린 것과 같이 그 문서와 이웃을 밝힌다 */
  highlight?: string | null
  compact?: boolean
  onOpen: (id: string) => void
  ref?: Ref<GraphHandle>
}) {
  const box = useRef<HTMLDivElement>(null)
  const graph = useRef<ForceGraph<GNode, GLink> | null>(null)
  const hover = useRef<string | null>(null)
  const linger = useRef<{ id: string; at: number } | null>(null)
  const pin = useRef<string | null>(null)
  const [pinned, setPinned] = useState<GNode | null>(null)
  // 이번 그림에서 강조할 문서와 그 세기(0~1). 그림마다 한 번 정해 모든 점 · 선이 같은 값을 본다.
  const act = useRef<{ id: string; s: number } | null>(null)
  const neighbors = useRef<Map<string, Set<string>>>(new Map())
  const colors = useRef(readColors())
  const focusRef = useRef(focus)
  focusRef.current = focus
  const matchRef = useRef(matches ?? new Set<string>())
  matchRef.current = matches ?? new Set<string>()
  const openRef = useRef(onOpen)
  openRef.current = onOpen
  const hubDeg = useRef(Infinity)
  // 선이 많으면 선이 점을 덮는다. 그때는 선을 더 옅게 그린다.
  const dense = useRef(false)
  const nodesById = useRef<Map<string, GNode>>(new Map())

  useImperativeHandle(ref, () => ({
    centerOn(id) {
      const g = graph.current
      const n = nodesById.current.get(id)
      if (!g || !n || n.x == null) return
      g.centerAt(n.x, n.y, 500)
      g.zoom(3, 500)
    },
  }))

  // 배치가 멈추면 라이브러리가 다시 그리기를 쉰다. 찾기 결과가 바뀌면 같은 배율로 한 번 다시 그리게 한다.
  useEffect(() => {
    if (graph.current) redraw(graph.current)
  }, [matches])

  // 목록에서 가리킨 문서를 캔버스에서도 밝힌다. 목록을 떠나면 바로 걷는다(목록은 줄 사이를 옮겨 다니므로 남겨 두면 엇갈린다).
  useEffect(() => {
    hover.current = highlight
    linger.current = null
    if (graph.current) redraw(graph.current)
  }, [highlight])

  function setPin(n: GNode | null) {
    pin.current = n?.id ?? null
    setPinned(n)
    if (graph.current) redraw(graph.current)
  }

  // 그래프는 한 번만 만들고 데이터만 바꾼다. 다시 만들면 배치가 처음부터 다시 흩어진다.
  useEffect(() => {
    if (!box.current) return
    let raf = 0
    // 걷히는 동안은 라이브러리가 다시 그리기를 쉬므로 매 프레임 다시 그리게 한다.
    const fadeLoop = () => {
      cancelAnimationFrame(raf)
      const step = () => {
        redraw(g)
        if (linger.current && performance.now() - linger.current.at < HOLD + FADE) raf = requestAnimationFrame(step)
        else {
          linger.current = null
          redraw(g)
        }
      }
      raf = requestAnimationFrame(step)
    }
    const g = new ForceGraph<GNode, GLink>(box.current)
      .backgroundColor('rgba(0,0,0,0)')
      .nodeId('id')
      .onRenderFramePre(() => {
        if (hover.current) act.current = { id: hover.current, s: 1 }
        else if (linger.current) {
          const t = performance.now() - linger.current.at
          // 고정된 문서가 있으면 걷지 않고, 잠시 뒤 고정된 쪽으로 돌아간다.
          if (pin.current) act.current = { id: t < HOLD ? linger.current.id : pin.current, s: 1 }
          else act.current = { id: linger.current.id, s: t < HOLD ? 1 : Math.max(0, 1 - (t - HOLD) / FADE) }
        } else act.current = pin.current ? { id: pin.current, s: 1 } : null
      })
      .linkColor((l) => {
        const c = colors.current
        const base = dense.current ? c.lineDense : c.line
        const a = act.current
        if (!a) return mix(base, base, 0)
        const hot = idOf(l.source) === a.id || idOf(l.target) === a.id
        return mix(base, hot ? c.lineHot : c.lineDim, a.s)
      })
      .linkWidth((l) => {
        const a = act.current
        return a && (idOf(l.source) === a.id || idOf(l.target) === a.id) ? lerp(0.6, 1.4, a.s) : 0.6
      })
      .nodeCanvasObject((n, ctx, scale) => {
        // 멀리서도 점이 사라지지 않게 화면에서 1.6px 아래로는 줄이지 않는다.
        const r = Math.max(radius(n), 1.6 / scale)
        const a = act.current
        const m = matchRef.current
        const isFocus = n.id === focusRef.current
        const isAct = !!a && n.id === a.id
        const isPin = n.id === pin.current
        // 강조가 없을 때의 모습(base)과 강조된 모습(act) 사이를 세기 s 로 옮겨 간다.
        const baseLit = m.size ? m.has(n.id) : true
        const lit = a ? isAct || !!neighbors.current.get(a.id)?.has(n.id) : baseLit
        const s = a?.s ?? 0
        ctx.globalAlpha = lerp(baseLit ? 1 : 0.12, lit ? 1 : 0.12, s)
        ctx.beginPath()
        ctx.arc(n.x!, n.y!, r, 0, 2 * Math.PI)
        ctx.fillStyle = colors.current.kind[n.kind]
        ctx.fill()
        if (isFocus || isPin || (isAct && s > 0.5)) {
          ctx.globalAlpha = 1
          ctx.lineWidth = (isPin ? 2.2 : 1.5) / scale
          ctx.strokeStyle = colors.current.text
          ctx.stroke()
        }
        // 이름은 멀리서는 쓰지 않고, 확대할수록 서서히 나타난다. 링크가 많은 문서는 조금 일찍 나온다.
        // 강조된 문서와 이웃 · 찾은 문서 · 가운데 문서는 배율과 상관없이 쓴다.
        // 2026.11.09 : 중심 문서 이름이 처음 맞춘 배율(1 안팎)에서는 안 보여 그림이 점뿐이었다. 1.1 → 0.7.
        const from = (n.deg || 0) >= hubDeg.current ? 0.7 : 2
        const zoomShow = Math.min(1, Math.max(0, (scale - from) / 0.6))
        const baseLabel = baseLit ? (isFocus || m.has(n.id) ? 1 : zoomShow) : 0
        const show = lerp(baseLabel, lit ? 1 : isFocus ? 0.5 : 0, s)
        if (show > 0.02) {
          const strong = isAct || isPin || isFocus
          ctx.globalAlpha = show
          ctx.font = `${strong ? 600 : 400} ${11 / scale}px Pretendard, 'Malgun Gothic', sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          ctx.lineWidth = 3 / scale
          ctx.lineJoin = 'round'
          ctx.strokeStyle = colors.current.bg
          ctx.strokeText(n.title, n.x!, n.y! + r + 2 / scale)
          ctx.fillStyle = strong ? colors.current.text : colors.current.label
          ctx.fillText(n.title, n.x!, n.y! + r + 2 / scale)
        }
        ctx.globalAlpha = 1
      })
      .nodePointerAreaPaint((n, color, ctx) => {
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(n.x!, n.y!, radius(n) + 2, 0, 2 * Math.PI)
        ctx.fill()
      })
      .onNodeHover((n, prev) => {
        hover.current = n?.id ?? null
        box.current!.style.cursor = n ? 'pointer' : ''
        if (n) {
          linger.current = null
          cancelAnimationFrame(raf)
          redraw(g)
        } else if (prev) {
          linger.current = { id: prev.id, at: performance.now() }
          fadeLoop()
        }
      })
      .onNodeClick((n, e) => {
        // 고정된 점을 다시 누르거나, Ctrl · ⌘ 를 누른 채 누르면 문서를 연다.
        if (pin.current === n.id || e.ctrlKey || e.metaKey) openRef.current(n.id)
        else setPin(n)
      })
      .onBackgroundClick(() => setPin(null))
      .cooldownTime(6000)
    g.d3Force('charge')?.strength(-45)
    graph.current = g
    const ro = new ResizeObserver(([e]) => g.width(e.contentRect.width).height(e.contentRect.height))
    ro.observe(box.current)
    // 화면 밝기는 머리말 메뉴로도 · 운영체제 설정으로도 바뀐다. 둘 다 <html> 의 .dark 로 모이므로 그것만 지켜본다.
    const recolor = () =>
      requestAnimationFrame(() => {
        colors.current = readColors()
        redraw(g)
      })
    const mo = new MutationObserver(recolor)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    // Esc 는 고정을 먼저 푼다. 풀 것이 있었으면 기본 동작을 막아, 둘레의 칸(문서 화면의 그래프 칸)이 함께 닫히지 않게 한다.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && pin.current) {
        e.preventDefault()
        setPin(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      ro.disconnect()
      mo.disconnect()
      g._destructor()
      graph.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const g = graph.current
    if (!g || !view) return
    // 링크 수 상위 10% 를 「중심 문서」로 본다. 이름이 조금 덜 확대해도 나온다.
    const degs = view.nodes.map((n) => n.deg || 0).sort((a, b) => b - a)
    hubDeg.current = Math.max(3, degs[Math.floor(degs.length * 0.1)] ?? Infinity)
    dense.current = view.links.length > 600
    nodesById.current = new Map(view.nodes.map((n) => [n.id, n]))
    const nb = neighbors.current
    nb.clear()
    for (const l of view.links) {
      const a = idOf(l.source), b = idOf(l.target)
      if (!nb.has(a)) nb.set(a, new Set())
      if (!nb.has(b)) nb.set(b, new Set())
      nb.get(a)!.add(b)
      nb.get(b)!.add(a)
    }
    // 보일 문서가 바뀌어 고정된 문서가 빠졌으면 고정을 푼다. 남았으면 새 객체로 바꿔 쥔다.
    if (pin.current) {
      const n = nodesById.current.get(pin.current) ?? null
      pin.current = n?.id ?? null
      setPinned(n)
    }
    hover.current = null
    linger.current = null
    // 배치를 화면에 내기 전에 미리 돌려 둔다. 그래야 처음 맞춘 자리에서 크게 벗어나지 않는다.
    // warmupTicks 는 graphData 보다 먼저 정해야 이번 데이터에 쓰인다.
    g.warmupTicks(view.nodes.length > 300 ? 80 : 150)
    box.current!.style.opacity = '0'
    g.graphData(view)
    // 2026.11.09 : 전에는 zoomToFit 으로 크게 당긴 뒤 0.45초 뒤에 배율 2 로 되돌려, 새로고침마다 한 번 확대됐다가
    //              축소되는 움직임이 보였다. 배율 상한을 넣은 맞춤 값을 한 번에, 움직임 없이 정한다.
    const t = setTimeout(() => {
      fit(g, 0)
      if (box.current) box.current.style.opacity = '1'
    }, 50)
    return () => clearTimeout(t)
  }, [view])

  function zoomBy(f: number) {
    const g = graph.current
    if (g) g.zoom(g.zoom() * f, 250)
  }

  const linkCount = pinned ? (neighbors.current.get(pinned.id)?.size ?? 0) : 0

  return (
    // 그래프 라이브러리가 자기 칸의 자식을 비우므로, 단추 · 안내는 그 칸 밖의 형제로 둔다.
    <div className="relative h-full min-h-0 overflow-hidden">
      <div ref={box} className="absolute inset-0" />
      {view && !view.nodes.length && <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">보일 문서가 없습니다.</p>}
      {pinned && (
        <div
          className={cn(
            'absolute top-2 left-2 z-10 flex max-w-[calc(100%-1rem)] items-center gap-2 rounded-md border bg-background/95 py-1 pr-1 pl-2.5 shadow-xs',
            compact ? 'text-xs' : 'text-sm',
          )}
        >
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: `var(${KIND_VAR[pinned.kind]})` }} />
          <span className="min-w-0 truncate font-medium">{pinned.title}</span>
          <span className="shrink-0 text-muted-foreground">이웃 {linkCount}</span>
          <Button size="xs" variant="secondary" onClick={() => onOpen(pinned.id)}>
            열기
            <ArrowRight />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="고정 풀기" onClick={() => setPin(null)}>
            <X />
          </Button>
        </div>
      )}
      <div className="absolute right-2 bottom-2 z-10 flex flex-col overflow-hidden rounded-md border bg-background/90 shadow-xs">
        <Button size="icon" variant="ghost" className={cn('rounded-none', compact ? 'size-7' : 'size-8')} aria-label="확대" onClick={() => zoomBy(1.5)}>
          <Plus />
        </Button>
        <Button size="icon" variant="ghost" className={cn('rounded-none border-y', compact ? 'size-7' : 'size-8')} aria-label="축소" onClick={() => zoomBy(1 / 1.5)}>
          <Minus />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={cn('rounded-none', compact ? 'size-7' : 'size-8')}
          aria-label="전체가 보이게 맞추기"
          onClick={() => graph.current && fit(graph.current, 400)}
        >
          <Maximize />
        </Button>
      </div>
    </div>
  )
}
