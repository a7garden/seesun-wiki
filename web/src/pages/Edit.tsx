import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { DiffView } from '@/components/HistorySpine'
import { LinkComplete } from '@/components/LinkComplete'
import { Markdown, wikiNames } from '@/components/Markdown'
import { forgetPreviews } from '@/components/WikiLink'
import { ApiError, get, pageUrl, post, q, uploadImage, type LinkMap, type Page } from '@/lib/api'
import { bundleOf, useSite } from '@/lib/site'
import { cn } from '@/lib/utils'
import { useSplat } from './PageView'

// 문서 편집 · 새 문서 화면.
//
// 목차
//   1. 링크 풀기    : 본문의 [[이름]] 을 미리보기용 주소로 (useLinks)
//   2. 주소 줄      : 묶음 / 종류 / 권 / 제목 — 저장하면 바뀌지 않는 문서 주소를 화면 머리에 그대로 짓는다 (CrumbInput)
//   3. 충돌 칸      : 편집하는 사이 남이 고쳤을 때 미리보기 자리에 그사이 바뀐 곳을 편다 (ConflictPane)
//   4. 편집 화면    : 불러오기 · 그림 붙이기 · 저장 · 지우기 (Edit)

type Kind = '개념' | '매뉴얼' | '일반'

// from : 이 문서의 묶음. [[이름]] 을 그 묶음 → 공통 순서로 찾는다(서버 resolve 와 같다).
function useLinks(body: string, from: string) {
  const [links, setLinks] = useState<LinkMap>({})
  const names = useMemo(() => [...new Set(wikiNames(body))].sort().join('\n'), [body])
  useEffect(() => {
    const t = setTimeout(() => {
      const list = names ? names.split('\n') : []
      if (list.length) post<LinkMap>('/api/links', { names: list, from }).then(setLinks, () => {})
      else setLinks({})
    }, 400)
    return () => clearTimeout(t)
  }, [names, from])
  return links
}

function Field({ label, htmlFor, children, className }: { label: string; htmlFor: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}

// 주소 줄의 칸 하나 : 글자 폭만큼만 차지하는 입력 칸. 고칠 수 있는 칸이라는 것은 점선 밑줄로 보인다.
function CrumbInput({ id, label, value, onChange, placeholder, list }: { id: string; label: string; value: string; onChange: (v: string) => void; placeholder?: string; list?: string }) {
  const len = Math.max(3, (value || placeholder || '').length)
  return (
    <input
      id={id}
      aria-label={label}
      list={list}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: `${len + 1.5}em` }}
      className="max-w-full rounded-sm border-b border-dashed border-foreground/30 bg-transparent px-0.5 text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-solid focus-visible:border-ring"
    />
  )
}

// 편집하는 사이 남이 고친 판 : 내 판의 바탕(base)에서 최신 판까지 바뀐 곳.
type Conflict = { latest: string; diff: string | null; error?: string }

// 충돌 칸 : 미리보기 자리를 차지한다. 내 글은 왼쪽 그대로 두고, 남의 고침을 그 옆에서 보며 내 글에 옮겨 넣는다.
// 2026.11.10 : 전에는 「본문을 따로 복사해 두고 이력에서 보라」는 알림뿐이라, 복사를 잊고 이력으로 넘어가면 쓴 글이 날아갔다.
// 바뀐 곳을 받지 못하면(그사이 문서가 지워졌을 때 등) 저장할 길이 없으므로, 다시 받기와 본문 복사를 둔다 — 새로 고치면 쓴 글이 날아간다.
function ConflictPane({ path, conflict, busy, body, onSave, onRetry }: { path: string; conflict: Conflict; busy: boolean; body: string; onSave: () => void; onRetry: () => void }) {
  const [copied, setCopied] = useState('')
  return (
    <div className="space-y-3" role="region" aria-label="그사이 바뀐 곳">
      <p className="text-sm">
        <span className="font-semibold text-destructive">편집하는 사이에 다른 사람이 이 문서를 고쳤습니다.</span> 아래에서 바뀐 곳을 보고 왼쪽 내 글에 옮겨 넣은 뒤 저장하세요.
        내 글은 그대로 남아 있습니다.
      </p>
      {conflict.error && <p className="text-sm text-destructive">{conflict.error}</p>}
      {!conflict.error && (conflict.diff === null ? <div className="h-24 animate-pulse rounded-lg bg-muted" /> : <DiffView diff={conflict.diff} className="text-[13px]" />)}
      <div className="flex flex-wrap items-center gap-3">
        {conflict.error ? (
          <>
            <Button onClick={onRetry} disabled={busy}>
              다시 받기
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                navigator.clipboard.writeText(body).then(
                  () => setCopied('본문을 복사했습니다.'),
                  () => setCopied('복사하지 못했습니다. 왼쪽 본문을 직접 골라 복사해 주세요.'),
                )
              }
            >
              내 본문 복사
            </Button>
          </>
        ) : (
          <Button onClick={onSave} disabled={busy || conflict.diff === null}>
            옮겨 넣었으니 저장
          </Button>
        )}
        <Link className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" to={pageUrl(path, '/history')} target="_blank" rel="noreferrer">
          이력 새 창으로 보기
        </Link>
      </div>
      {copied && <p className="text-sm text-muted-foreground" role="status">{copied}</p>}
    </div>
  )
}

export function Edit({ isNew = false }: { isNew?: boolean }) {
  const splat = useSplat()
  const [params] = useSearchParams()
  const { site, reload } = useSite()
  const nav = useNavigate()

  // 경로는 <묶음>/<종류>/<이름> · <묶음>/매뉴얼/<권>/<이름> 이다.
  const presetPath = isNew ? params.get('path') || '' : splat
  const preset = presetPath.split('/')
  const presetKind = preset.length > 2 ? preset[1] : ''
  // 「묶음과 권」 · 빈 권의 「첫 문서 쓰기」는 path 대신 bundle · kind · group 을 넘긴다(제목은 쓰는 사람이 정한다).
  const [bundle, setBundle] = useState(() => bundleOf(presetPath) || (isNew && params.get('bundle')) || '')
  const [kind, setKind] = useState<Kind>(() => {
    const k = presetKind || (isNew && params.get('kind')) || ''
    return k === '매뉴얼' ? '매뉴얼' : k === '개념' || !k ? (presetPath && !presetKind ? '일반' : '개념') : '일반'
  })
  const [group, setGroup] = useState(() => (presetKind === '매뉴얼' && preset.length > 3 ? preset[2] : (isNew && params.get('group')) || ''))
  const [title, setTitle] = useState(params.get('title') || presetPath.split('/').pop() || '')
  const [aliases, setAliases] = useState('')
  const [order, setOrder] = useState('')
  const [body, setBody] = useState('')
  const [message, setMessage] = useState('')
  const [base, setBase] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(isNew)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [busy, setBusy] = useState(false)
  const [pane, setPane] = useState<'write' | 'preview'>('write')
  const area = useRef<HTMLTextAreaElement>(null)
  const theBundle = bundle.trim() || site?.bundle || ''

  useEffect(() => {
    if (isNew) return
    get<Page>(`/api/page?${q(splat)}`).then(
      (p) => {
        setTitle(p.title)
        setAliases(p.aliases.join(', '))
        setOrder(p.meta.order != null ? String(p.meta.order) : '')
        setBody(p.body)
        setBase(p.commit)
        setLoaded(true)
      },
      (e: ApiError) => (e.status === 404 ? nav(`/new?path=${encodeURIComponent(splat)}`, { replace: true }) : setError(e.message)),
    )
  }, [isNew, splat, nav])

  // 새 문서의 경로는 묶음 · 종류 · 권 · 제목으로 정한다. 저장한 뒤에는 경로가 바뀌지 않는다(바깥 링크가 깨지지 않게).
  const path = isNew
    ? params.get('path') || (title.trim() ? [theBundle, kind === '일반' ? '' : kind, kind === '매뉴얼' ? group.trim() : '', title.trim()].filter(Boolean).join('/') : '')
    : splat
  const links = useLinks(body, bundleOf(path) || theBundle)

  if (site && !site.user) {
    return (
      <p className="text-muted-foreground">
        <Link className="underline" to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}>
          로그인
        </Link>
        해야 고칠 수 있습니다.
      </p>
    )
  }
  if (!loaded) return error ? <p className="text-destructive">{error}</p> : null

  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    // 2026.11.11 : html 파일(움직이는 도식)도 붙여 넣으면 올린다. 높이는 제목 칸에 적는다(기본 480).
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/') || f.type === 'text/html')
    if (!file) return
    e.preventDefault()
    try {
      const { url } = await uploadImage(file)
      insert(file.type === 'text/html' ? `![움직이는 도식](${url} "480")\n*도식 설명*\n` : `![](${url})\n`)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  function insert(text: string) {
    const el = area.current
    if (!el) return setBody((b) => b + text)
    const { selectionStart: s, selectionEnd: t } = el
    setBody((b) => b.slice(0, s) + text + b.slice(t))
    requestAnimationFrame(() => el.setSelectionRange(s + text.length, s + text.length))
  }

  // 충돌을 만나면 최신 판과 그사이 바뀐 곳을 받아 충돌 칸에 편다. 바탕은 아직 옮기지 않는다 — 바뀐 곳을 보고 「옮겨 넣었으니 저장」을 눌러야 옮긴다.
  async function openConflict() {
    setPane('preview')
    try {
      const head = (await get<Page>(`/api/page?${q(path)}`)).commit
      if (!head) throw new Error('이 문서의 최신 판을 찾지 못했습니다. 이력에서 확인해 주세요.')
      setConflict({ latest: head, diff: null })
      const d = await get<{ diff: string }>(`/api/diff?${q(path)}&${base ? `a=${base}&` : ''}b=${head}`)
      setConflict({ latest: head, diff: d.diff })
    } catch (e) {
      setConflict({ latest: '', diff: null, error: (e as Error).message })
    }
  }

  async function save(baseOverride?: string) {
    setBusy(true)
    setError('')
    try {
      const r = await post<{ path: string }>('/api/page', {
        path,
        title,
        aliases: aliases.split(',').map((s) => s.trim()).filter(Boolean),
        order: kind === '매뉴얼' || order ? order : '',
        body,
        message,
        base: isNew ? null : (baseOverride ?? base),
      })
      forgetPreviews()
      await reload()
      nav(pageUrl(r.path))
    } catch (e) {
      const err = e as ApiError
      if (err.status === 409) await openConflict()
      else setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await post('/api/page/delete', { path, message: `${title} 지움` })
      await reload()
      nav('/')
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const groups = site?.manual.filter((g) => g.bundle === theBundle).map((g) => g.name).filter(Boolean) ?? []

  return (
    <div className="space-y-5">
      {/* 머리 : 주소 줄(묶음 / 종류 / 권 /) 아래에 제목 칸을 큰 제목으로 둔다. 둘이 이어 문서 주소가 된다.
          2026.11.10 : 전에는 묶음 · 종류 · 권 · 제목이 네 칸 격자였고, 그 결과인 주소는 아래 회색 글 한 줄이었다.
          주소는 저장한 뒤 바뀌지 않으므로(바깥 링크가 깨지지 않게) 가장 잘 보여야 한다. */}
      <div className="flex items-start gap-3">
        <h1 className="sr-only">{isNew ? '새 문서' : `${title} 편집`}</h1>
        <div className="min-w-0 flex-1">
          {/* 칸과 / 는 실제 주소의 칸과 같게 그린다 — 「일반」은 주소에 들어가지 않고, 권을 비운 매뉴얼은 권 칸이 없다 */}
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground" title={path ? `문서 주소 : ${path}` : undefined}>
            {isNew && !params.get('path') ? (
              <>
                <CrumbInput id="bundle" label="묶음" list="bundles" value={bundle} onChange={setBundle} placeholder={site?.bundle} />
                <datalist id="bundles">
                  {site?.bundles.map((b) => (
                    <option key={b.name} value={b.name} />
                  ))}
                </datalist>
                <span aria-hidden>/</span>
                <select
                  id="kind"
                  aria-label="종류"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as Kind)}
                  className="rounded-sm border-b border-dashed border-foreground/30 bg-transparent text-foreground outline-none focus-visible:border-solid focus-visible:border-ring"
                >
                  <option value="개념">개념 (용어 하나)</option>
                  <option value="매뉴얼">매뉴얼 (순서대로 읽는 안내)</option>
                  <option value="일반">일반 (주소에 넣지 않음)</option>
                </select>
                {kind !== '일반' && <span aria-hidden>/</span>}
                {kind === '매뉴얼' && (
                  <>
                    <CrumbInput id="group" label="매뉴얼 권" list="groups" value={group} onChange={setGroup} placeholder="권 (비우면 권 없이)" />
                    <datalist id="groups">
                      {groups.map((g) => (
                        <option key={g} value={g} />
                      ))}
                    </datalist>
                    {group.trim() && <span aria-hidden>/</span>}
                  </>
                )}
              </>
            ) : (
              <span>{path.split('/').slice(0, -1).join(' / ')} /</span>
            )}
          </div>
          <input
            id="title"
            aria-label="제목"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="제목"
            required
            className="mt-1 w-full border-b border-transparent bg-transparent pb-1 text-3xl font-bold tracking-tight outline-none placeholder:text-muted-foreground/50 hover:border-border focus-visible:border-ring"
          />
        </div>
        {/* 지우기는 저장 줄에서 떼어 둔다. 저장 · 취소 옆에 붉은 단추가 있으면 손이 잘못 갈 자리가 된다. */}
        <div className="shrink-0 pt-1">
          {!isNew && (
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="ghost" size="sm" className="text-destructive">
                  지우기
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>「{title}」 문서를 지울까요?</DialogTitle>
                  <DialogDescription>목록과 링크에서 사라집니다. 지난 판은 이력에 남아 있어 다시 살릴 수 있습니다.</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="destructive" onClick={remove} disabled={busy}>
                    지우기
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
        <Field label="다른 이름 (쉼표로 구분)" htmlFor="aliases">
          <Input id="aliases" value={aliases} onChange={(e) => setAliases(e.target.value)} />
        </Field>
        {(kind === '매뉴얼' || path.split('/')[1] === '매뉴얼') && (
          <Field label="권 안 순서" htmlFor="order">
            <Input id="order" type="number" value={order} onChange={(e) => setOrder(e.target.value)} placeholder="작을수록 앞" />
          </Field>
        )}
      </div>
      <div className="flex gap-1 lg:hidden" role="tablist">
        {(['write', 'preview'] as const).map((p) => (
          <Button key={p} size="sm" variant={pane === p ? 'secondary' : 'ghost'} onClick={() => setPane(p)} role="tab" aria-selected={pane === p}>
            {p === 'write' ? '본문' : conflict ? '바뀐 곳' : '미리보기'}
          </Button>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className={cn('relative space-y-1.5', pane === 'preview' && 'hidden lg:block')}>
          <LinkComplete area={area} setBody={setBody} />
          <Textarea
            ref={area}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onPaste={onPaste}
            aria-label="본문"
            className="min-h-[60svh] font-sans text-[15px] leading-relaxed break-keep"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">[[ 를 치면 이을 문서 이름이 뜹니다. 그림은 본문에 붙여 넣으면 올라갑니다.</p>
        </div>
        <div className={cn('min-h-[60svh] rounded-lg border p-5', conflict && 'border-destructive/50', pane === 'write' && 'hidden lg:block')}>
          {conflict ? (
            <ConflictPane
              path={path}
              conflict={conflict}
              busy={busy}
              body={body}
              onRetry={openConflict}
              onSave={() => {
                const latest = conflict.latest
                setBase(latest)
                setConflict(null)
                save(latest)
              }}
            />
          ) : (
            <Markdown source={body} links={links} />
          )}
        </div>
      </div>

      {/* 저장 줄은 화면 아래에 붙인다. 긴 문서에서 끝까지 내려가야 저장할 수 있으면 안 된다. */}
      <div className="sticky bottom-0 z-10 -mx-4 space-y-3 border-t bg-background/95 px-4 py-3 backdrop-blur">
        {conflict && <p className="text-sm text-destructive">다른 사람이 그사이 고쳤습니다. 미리보기 자리의 바뀐 곳을 보고 「옮겨 넣었으니 저장」을 누르세요.</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex flex-wrap items-end gap-3">
          <Field label="무엇을 바꿨나요" htmlFor="message" className="min-w-40 flex-1">
            <Input id="message" value={message} onChange={(e) => setMessage(e.target.value)} placeholder={isNew ? `${title || '문서'} 새로 씀` : `${title} 고침`} />
          </Field>
          <Button onClick={() => save()} disabled={busy || !title.trim() || !path || !!conflict}>
            저장
          </Button>
          <Button variant="ghost" onClick={() => nav(-1)}>
            취소
          </Button>
        </div>
      </div>
    </div>
  )
}
