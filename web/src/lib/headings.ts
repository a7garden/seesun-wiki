import GithubSlugger from 'github-slugger'

// 본문의 ## · ### 제목과 화면이 붙일 id. 오른쪽 차례 · 본문 [목차] · ![[문서#절]] 끼워 넣기가 함께 쓴다.
// id 는 rehype-slug 와 같아야 차례를 눌렀을 때 그 제목으로 간다. 서버 pages.rs 의 Slugger 도 같은 규칙이다.

export interface Heading {
  depth: number
  text: string
  id: string
  line: number
}

const clean = (s: string) => s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, l) => l || t).replace(/[*_`]/g, '').trim()

/** 모든 단계 제목. # · #### 도 id 순번을 먹으므로 함께 센다(차례에는 2 · 3 단계만 보인다). */
export function headings(body: string): Heading[] {
  const slugger = new GithubSlugger()
  const out: Heading[] = []
  let fence = false
  body.split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('```')) fence = !fence
    const m = !fence && line.match(/^(#{1,6})\s+(.+?)\s*#*$/)
    if (m) {
      const text = clean(m[2])
      out.push({ depth: m[1].length, text, id: slugger.slug(text), line: i })
    }
  })
  return out
}

export const tocHeadings = (body: string) => headings(body).filter((h) => h.depth === 2 || h.depth === 3)

/** 「[목차]」 한 줄이 본문에 있는가. 있으면 좁은 화면용 접는 차례를 따로 그리지 않는다. */
export const hasTocMark = (body: string) => /^[ \t]*\[목차\][ \t]*$/m.test(body)

/** 제목 글자나 id 로 절 하나를 잘라 낸다 : 그 제목 줄부터 같거나 높은 단계의 다음 제목 앞까지. 못 찾으면 null. */
export function sectionOf(body: string, name: string) {
  const want = clean(name).toLowerCase()
  const hs = headings(body)
  const i = hs.findIndex((h) => h.text.toLowerCase() === want || h.id === want)
  if (i < 0) return null
  const end = hs.slice(i + 1).find((h) => h.depth <= hs[i].depth)
  const lines = body.split('\n')
  return { id: hs[i].id, body: lines.slice(hs[i].line, end ? end.line : lines.length).join('\n') }
}
