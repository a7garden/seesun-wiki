import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Copy } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { get, post, when, type User } from '@/lib/api'
import { useSite } from '@/lib/site'

/** 소속 고르기. 목록은 서버 설정(data/settings.json 의 orgs)에서 온다. */
function OrgSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const { site } = useSite()
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} required className="h-9 w-full rounded-md border bg-transparent px-3 text-sm">
      <option value="" disabled>
        고르세요
      </option>
      {site?.orgs.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}

function Row({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  )
}

export function Login() {
  const { site, reload } = useSite()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const [id, setId] = useState('')
  const [pw, setPw] = useState('')
  const [error, setError] = useState('')
  if (site?.needsSetup) return <Signup first />
  return (
    <form
      className="mx-auto mt-8 max-w-sm space-y-4"
      onSubmit={async (e) => {
        e.preventDefault()
        setError('')
        try {
          await post('/api/login', { id, password: pw })
          await reload()
          nav(params.get('next') || '/')
        } catch (err) {
          setError((err as Error).message)
        }
      }}
    >
      <h1 className="text-2xl font-bold">로그인</h1>
      <Row id="id" label="아이디">
        <Input id="id" value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" required />
      </Row>
      <Row id="pw" label="비밀번호">
        <Input id="pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" required />
      </Row>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full">
        로그인
      </Button>
      {site?.openSignup && (
        <p className="text-center text-sm text-muted-foreground">
          계정이 없으면 <Link to="/signup" className="underline">가입</Link>
        </p>
      )}
    </form>
  )
}

export function Signup({ first = false }: { first?: boolean }) {
  const { site, reload } = useSite()
  const nav = useNavigate()
  const [f, setF] = useState({ id: '', org: '', password: '' })
  const [error, setError] = useState('')
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value })
  if (site && !site.openSignup && !site.needsSetup) return <p className="text-muted-foreground">지금은 관리자만 계정을 만들 수 있습니다.</p>
  return (
    <form
      className="mx-auto mt-8 max-w-sm space-y-4"
      onSubmit={async (e) => {
        e.preventDefault()
        setError('')
        try {
          await post('/api/signup', f)
          await reload()
          nav('/')
        } catch (err) {
          setError((err as Error).message)
        }
      }}
    >
      <h1 className="text-2xl font-bold">{first ? '첫 관리자 계정 만들기' : '가입'}</h1>
      {first && <p className="text-sm text-muted-foreground">아직 계정이 하나도 없습니다. 여기서 만드는 계정이 관리자가 됩니다.</p>}
      <Row id="sid" label="아이디 (영문 소문자 · 숫자)">
        <Input id="sid" value={f.id} onChange={set('id')} autoComplete="username" required />
      </Row>
      <Row id="sorg" label="소속">
        <OrgSelect id="sorg" value={f.org} onChange={(org) => setF({ ...f, org })} />
      </Row>
      <p className="text-sm text-muted-foreground">이름은 받지 않습니다. 고친 기록에는 계정마다 하나씩 주는 해시만 남습니다.</p>
      <Row id="spw" label="비밀번호 (8자 이상)">
        <Input id="spw" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" minLength={8} required />
      </Row>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full">
        {first ? '만들기' : '가입'}
      </Button>
    </form>
  )
}

interface Token {
  id: string
  label: string
  created: string
  used?: string
}

function CopyBlock({ text }: { text: string }) {
  return (
    <div className="relative">
      <pre className="rounded-md bg-muted p-3 pr-12 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</pre>
      <Button size="icon" variant="ghost" className="absolute top-1.5 right-1.5" onClick={() => navigator.clipboard.writeText(text)} aria-label="복사">
        <Copy />
      </Button>
    </div>
  )
}

export function Account() {
  const { site, reload } = useSite()
  const [orgMsg, setOrgMsg] = useState('')
  const [tokens, setTokens] = useState<Token[]>([])
  const [label, setLabel] = useState('')
  const [fresh, setFresh] = useState<string | null>(null)
  const [pw, setPw] = useState({ current: '', password: '' })
  const [msg, setMsg] = useState('')
  const load = () => get<Token[]>('/api/tokens').then(setTokens, () => {})
  useEffect(() => {
    load()
  }, [])
  if (!site?.user) return <p className="text-muted-foreground">로그인해 주세요.</p>
  const url = site.mcpUrl
  const tok = fresh || '<토큰>'
  return (
    <div className="max-w-2xl space-y-12">
      <section className="space-y-4">
        <h1 className="font-mono text-2xl font-bold">{site.user.tag}</h1>
        <p className="text-sm text-muted-foreground">
          아이디 {site.user.id} · {site.user.role === 'admin' ? '관리자' : '편집자'} · 고친 기록에는 이 해시만 남습니다
        </p>
        <Row id="org" label="소속">
          <div className="max-w-xs">
            <OrgSelect
              id="org"
              value={site.user.org}
              onChange={async (org) => {
                setOrgMsg('')
                try {
                  await post('/api/profile', { org })
                  await reload()
                  setOrgMsg('바꿨습니다.')
                } catch (err) {
                  setOrgMsg((err as Error).message)
                }
              }}
            />
          </div>
        </Row>
        {orgMsg && <p className="text-sm text-muted-foreground">{orgMsg}</p>}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-bold">MCP 토큰</h2>
        <p className="text-sm text-muted-foreground">AI 도구가 이 토큰으로 위키를 읽고 고칩니다. 고친 기록에는 내 해시가 남습니다.</p>
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            const r = await post<Token & { token: string }>('/api/tokens', { label: label || 'MCP' })
            setFresh(r.token)
            setLabel('')
            load()
          }}
        >
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="어디서 쓸 토큰인지 (예: 회사 노트북 Claude Code)" aria-label="토큰 이름" />
          <Button type="submit">만들기</Button>
        </form>
        {fresh && (
          <Alert>
            <AlertDescription className="space-y-2">
              <p>이 토큰은 지금 한 번만 보입니다. 아래 명령을 바로 복사해 두세요.</p>
            </AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <p className="text-sm font-medium">Claude Code</p>
          <CopyBlock text={`claude mcp add --transport http wiki ${url} --header "Authorization: Bearer ${tok}"`} />
          <p className="pt-2 text-sm font-medium">그 밖의 MCP 도구 (설정 JSON)</p>
          <CopyBlock text={JSON.stringify({ mcpServers: { wiki: { type: 'http', url, headers: { Authorization: `Bearer ${tok}` } } } }, null, 2)} />
        </div>
        {tokens.length > 0 && (
          <ul className="divide-y rounded-lg border text-sm">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{t.label}</div>
                  <div className="text-muted-foreground">
                    {when(t.created)} 만듦{t.used ? ` · ${when(t.used)} 마지막 사용` : ' · 아직 안 씀'}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={async () => {
                    await post('/api/tokens/delete', { id: t.id })
                    load()
                  }}
                >
                  폐기
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-bold">비밀번호 바꾸기</h2>
        <form
          className="max-w-sm space-y-3"
          onSubmit={async (e) => {
            e.preventDefault()
            setMsg('')
            try {
              await post('/api/password', pw)
              setPw({ current: '', password: '' })
              setMsg('바꿨습니다.')
            } catch (err) {
              setMsg((err as Error).message)
            }
          }}
        >
          <Row id="cur" label="지금 비밀번호">
            <Input id="cur" type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" required />
          </Row>
          <Row id="new" label="새 비밀번호 (8자 이상)">
            <Input id="new" type="password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} autoComplete="new-password" minLength={8} required />
          </Row>
          {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
          <Button type="submit">바꾸기</Button>
        </form>
      </section>
    </div>
  )
}

export function Admin() {
  const { site, reload } = useSite()
  const [data, setData] = useState<{ users: User[]; settings: { openSignup: boolean } } | null>(null)
  const [error, setError] = useState('')
  const load = () => get<typeof data>('/api/admin').then(setData, (e) => setError(e.message))
  useEffect(() => {
    load()
  }, [])
  if (error) return <p className="text-destructive">{error}</p>
  if (!data) return null
  return (
    <div className="max-w-3xl space-y-10">
      <h1 className="text-2xl font-bold">관리</h1>
      <section className="space-y-3">
        <h2 className="text-lg font-bold">가입</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={data.settings.openSignup}
            onChange={async (e) => {
              await post('/api/admin/settings', { openSignup: e.target.checked })
              await load()
              await reload()
            }}
          />
          누구나 가입할 수 있게 둔다 (끄면 관리자가 가입 화면에서 대신 만든다)
        </label>
        {!data.settings.openSignup && (
          <Button variant="outline" size="sm" asChild>
            <Link to="/signup">계정 만들기</Link>
          </Button>
        )}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-bold">계정 {data.users.length}</h2>
        <ul className="divide-y rounded-lg border text-sm">
          {data.users.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <span className="font-mono font-medium">{u.tag}</span> <span className="text-muted-foreground">{u.id} · {u.org || '소속 없음'}</span>
              </div>
              <select
                value={u.role}
                disabled={u.id === site?.user?.id}
                onChange={async (e) => {
                  await post('/api/admin/role', { id: u.id, role: e.target.value })
                  load()
                }}
                className="h-8 rounded-md border bg-transparent px-2"
                aria-label={`${u.id} 권한`}
              >
                <option value="editor">편집자</option>
                <option value="admin">관리자</option>
              </select>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  const p = prompt(`${u.id} 의 새 비밀번호 (8자 이상)`)
                  if (!p) return
                  try {
                    await post('/api/admin/password', { id: u.id, password: p })
                    alert('바꿨습니다.')
                  } catch (err) {
                    alert((err as Error).message)
                  }
                }}
              >
                비밀번호 재설정
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
