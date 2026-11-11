import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { ArrowDown, ArrowUp, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { get, post } from '@/lib/api'
import { useSite } from '@/lib/site'
import { cn } from '@/lib/utils'

// 「묶음과 권」 화면 : 묶음(업무 분야)과 그 안 매뉴얼 권을 만들고 설명 · 공유 여부 · 순서를 고친다.
// 2026.11.10 : 묶음 · 권이 문서 경로로만 생기고 「공통」이 코드에 박혀 있던 것을, 편집자 누구나 여기서 만들게 했다(서버 bundles.rs).
// 이름은 문서 경로의 한 칸이라 바꾸지 않는다. 지우기는 문서가 하나도 없을 때만 된다.
// 2026.11.10 : 고치기는 대화상자 대신 그 자리에서 한다 — 설명은 글을 눌러 고치고, 권 순서는 위 · 아래 단추로 옮긴다(숫자 칸은 결과를 미리 볼 수 없었다).
//              공유 묶음은 배지 대신 맨 아래 「모든 묶음에 함께 보임」 바닥층에 따로 둔다. 어느 묶음 밑에나 깔린다는 구조를 자리로 보인다.
//
// 목차
//   1. 만들기 대화상자 : 묶음 · 권 만들기 (CreateDialog)
//   2. 제자리 설명     : 글을 눌러 고치는 설명 한 줄 (InlineAbout)
//   3. 묶음 한 칸      : 공유 여부 · 설명 · 권 차례(옮기기 · 새 문서 · 지우기) (BundleSection)
//   4. 화면            : 이 묶음들 → 공유 바닥층 (Bundles)

type Volume = { name: string; about: string; order: number | null; count: number; listed: boolean }
type Bundle = { name: string; count: number; shared: boolean; about: string; listed: boolean; volumes: Volume[] }

// 만들기 대화상자. 이름은 만든 뒤 바꿀 수 없어 한 번 멈춰 확인하는 대화상자에 둔다. fields 에 없는 칸은 그리지 않는다.
function CreateDialog({
  trigger,
  title,
  description,
  fields,
  submit,
}: {
  trigger: React.ReactNode
  title: string
  description?: string
  fields: ('name' | 'about' | 'shared')[]
  submit: (v: { name: string; about: string; shared: boolean }) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [v, setV] = useState({ name: '', about: '', shared: false })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) {
          setV({ name: '', about: '', shared: false })
          setError('')
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setError('')
            try {
              await submit(v)
              setOpen(false)
            } catch (err) {
              setError((err as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          {fields.includes('name') && (
            <div className="space-y-1.5">
              <Label htmlFor="b-name">이름</Label>
              <Input id="b-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required autoFocus />
              <p className="text-xs text-muted-foreground">문서 주소의 한 칸이 됩니다. 만든 뒤에는 바꿀 수 없습니다.</p>
            </div>
          )}
          {fields.includes('about') && (
            <div className="space-y-1.5">
              <Label htmlFor="b-about">설명</Label>
              <Textarea id="b-about" value={v.about} onChange={(e) => setV({ ...v, about: e.target.value })} rows={2} placeholder="무엇을 모아 두는 곳인지 한 줄로" />
            </div>
          )}
          {fields.includes('shared') && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={v.shared} onChange={(e) => setV({ ...v, shared: e.target.checked })} />
              <span>
                공유 묶음으로 둔다
                <span className="block text-xs text-muted-foreground">어느 묶음을 보든 이 묶음의 개념 · 매뉴얼이 함께 보이고, [[이름]] 링크가 지금 묶음에 없으면 여기서 찾습니다.</span>
              </span>
            </label>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              만들기
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// 그 자리에서 고치는 설명 한 줄. 글을 누르면 칸이 되고 Enter · 칸 밖을 누르면 저장, Esc 는 그만둔다.
// 고칠 수 없는 사람에게는 글만 보인다.
function InlineAbout({ value, label, can, save, className }: { value: string; label: string; can: boolean; save: (v: string) => Promise<void>; className?: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState('')
  const done = useRef(false)
  if (!can) return value ? <p className={cn('text-muted-foreground', className)}>{value}</p> : null
  if (!editing)
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value)
          setError('')
          done.current = false
          setEditing(true)
        }}
        aria-label={`${label} 설명 고치기`}
        className={cn('-mx-1 block max-w-full rounded px-1 text-left text-muted-foreground hover:bg-accent hover:text-foreground', !value && 'text-muted-foreground/70 italic', className)}
      >
        {value || '설명 쓰기'}
      </button>
    )
  const commit = async () => {
    // Enter 로 저장한 뒤 칸이 사라지며 blur 가 한 번 더 오므로 한 번만 저장한다
    if (done.current) return
    done.current = true
    if (draft.trim() === value) return setEditing(false)
    try {
      await save(draft.trim())
      setEditing(false)
    } catch (e) {
      done.current = false
      setError((e as Error).message)
    }
  }
  return (
    <div className={className}>
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            done.current = true
            setEditing(false)
          }
        }}
        aria-label={`${label} 설명`}
        placeholder="무엇을 모아 두는 곳인지 한 줄로"
        className="h-8"
      />
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}

function BundleSection({ b, can, done, remove }: { b: Bundle; can: boolean; done: () => Promise<void>; remove: (url: string, body: unknown, what: string) => Promise<void> }) {
  // 옮기는 중인 차례. 서버가 받은 뒤 새 목록이 오면 비운다 — 그동안 화면이 옮긴 자리를 먼저 보인다.
  const [moving, setMoving] = useState<Volume[] | null>(null)
  const [error, setError] = useState('')
  const volumes = moving ?? b.volumes

  // 권 하나를 위 · 아래로 옮긴다. 서버가 거절하면 원래 차례로 돌아간다.
  // 옮기는 동안은 위 · 아래 단추를 잠근다 — 앞 요청이 끝나기 전에 다음 요청이 가면 서버에 적히는 차례가 엇갈린다.
  async function move(i: number, d: -1 | 1) {
    const next = [...volumes]
    ;[next[i], next[i + d]] = [next[i + d], next[i]]
    setMoving(next)
    setError('')
    try {
      await post('/api/volume/order', { bundle: b.name, names: next.map((v) => v.name) })
      await done()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setMoving(null)
    }
  }

  return (
    <section className="border-t pt-5" aria-labelledby={`b-${b.name}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`b-${b.name}`} className="text-lg font-bold">
          {b.name}
        </h2>
        <span className="text-sm text-muted-foreground tabular-nums">문서 {b.count}</span>
        {can && (
          <div className="ml-auto flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={async () => {
                try {
                  await post('/api/bundle', { name: b.name, about: b.about, shared: !b.shared })
                  await done()
                } catch (e) {
                  setError((e as Error).message)
                }
              }}
            >
              {b.shared ? '공유 풀기' : '공유 묶음으로 두기'}
            </Button>
            {b.count === 0 && (
              <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove('/api/bundle/delete', { name: b.name }, `「${b.name}」 묶음`)}>
                지우기
              </Button>
            )}
          </div>
        )}
      </div>
      <InlineAbout
        value={b.about}
        label={`「${b.name}」 묶음`}
        can={can}
        className="mt-0.5 text-sm"
        save={async (about) => {
          await post('/api/bundle', { name: b.name, about, shared: b.shared })
          await done()
        }}
      />
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      {/* 권 : 차례 번호가 곧 책 차례다. 번호 옆 위 · 아래 단추로 옮긴다 */}
      <ol className="mt-3 text-sm">
        {volumes.map((v, i) => (
          <li key={v.name} className="group flex items-start gap-3 rounded-md px-1 py-2 hover:bg-accent/40">
            <span className="w-5 shrink-0 pt-0.5 text-right text-muted-foreground tabular-nums">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <span className="font-medium">{v.name}</span> <span className="text-muted-foreground tabular-nums">· 문서 {v.count}</span>
              <InlineAbout
                value={v.about}
                label={`「${v.name}」 권`}
                can={can}
                className="text-xs"
                save={async (about) => {
                  await post('/api/volume', { bundle: b.name, name: v.name, about, order: v.order })
                  await done()
                }}
              />
            </div>
            {can && (
              <div className="flex shrink-0 items-center gap-0.5">
                <Button variant="ghost" size="icon-sm" className="pointer-coarse:size-10" disabled={i === 0 || !!moving} aria-label={`「${v.name}」 권을 위로`} onClick={() => move(i, -1)}>
                  <ArrowUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="pointer-coarse:size-10"
                  disabled={i === volumes.length - 1 || !!moving}
                  aria-label={`「${v.name}」 권을 아래로`}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown />
                </Button>
                <Button variant="ghost" size="sm" asChild>
                  <Link to={`/new?bundle=${encodeURIComponent(b.name)}&kind=${encodeURIComponent('매뉴얼')}&group=${encodeURIComponent(v.name)}`}>새 문서</Link>
                </Button>
                {v.count === 0 && (
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove('/api/volume/delete', { bundle: b.name, name: v.name }, `「${v.name}」 권`)}>
                    지우기
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
        {volumes.length === 0 && <li className="px-1 py-2 text-muted-foreground">매뉴얼 권이 아직 없습니다.</li>}
      </ol>
      {can && (
        <CreateDialog
          trigger={
            <Button variant="ghost" size="sm" className="mt-1 text-muted-foreground">
              <Plus /> 권 만들기
            </Button>
          }
          title={`「${b.name}」 묶음에 새 권`}
          description="예: 위키 사용법 · 사전검토 업무. 만든 권은 차례 맨 뒤에 붙고, 「새 문서」로 첫 문서를 씁니다."
          fields={['name', 'about']}
          submit={async (v) => {
            await post('/api/volume', { bundle: b.name, name: v.name, about: v.about, create: true })
            await done()
          }}
        />
      )}
    </section>
  )
}

export function Bundles() {
  const { site, reload } = useSite()
  const [list, setList] = useState<Bundle[] | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => get<Bundle[]>('/api/bundles').then(setList, (e: Error) => setError(e.message)), [])
  useEffect(() => {
    load()
  }, [load])
  const can = !!site?.user
  const done = async () => {
    await load()
    await reload()
  }
  const remove = async (url: string, body: unknown, what: string) => {
    if (!confirm(`${what}을(를) 지울까요?`)) return
    try {
      await post(url, body)
      await done()
    } catch (e) {
      alert((e as Error).message)
    }
  }
  const own = list?.filter((b) => !b.shared) ?? []
  const shared = list?.filter((b) => b.shared) ?? []
  return (
    <div className="max-w-3xl space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">묶음과 권</h1>
        {can ? (
          <CreateDialog
            trigger={
              <Button size="sm" className="ml-auto">
                <Plus /> 묶음 만들기
              </Button>
            }
            title="새 묶음"
            fields={['name', 'about', 'shared']}
            submit={async (v) => {
              await post('/api/bundle', { ...v, create: true })
              await done()
            }}
          />
        ) : (
          <p className="ml-auto text-sm text-muted-foreground">
            <Link className="underline" to="/login?next=/bundles">
              로그인
            </Link>
            하면 묶음과 권을 고칠 수 있습니다.
          </p>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!list && !error && <div className="h-40 animate-pulse rounded-lg bg-muted/60" />}
      {own.map((b) => (
        <BundleSection key={b.name} b={b} can={can} done={done} remove={remove} />
      ))}
      {shared.length > 0 && (
        <div className="space-y-8 rounded-xl bg-surface px-5 pt-1 pb-5 [&>section:first-of-type]:border-t-0 [&>section:first-of-type]:pt-0">
          <p className="pt-4 text-xs font-medium text-muted-foreground">모든 묶음에 함께 보임 · 어느 묶음을 보든 이 개념 · 매뉴얼이 같이 나오고, [[이름]] 링크가 지금 묶음에 없으면 여기서 찾습니다</p>
          {shared.map((b) => (
            <BundleSection key={b.name} b={b} can={can} done={done} remove={remove} />
          ))}
        </div>
      )}
    </div>
  )
}
