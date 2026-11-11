// 서버를 빈 저장소로 띄워 API · 이력 · 충돌 · MCP 를 한 바퀴 돈다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 4590 + Math.floor(Math.random() * 9);
const B = `http://127.0.0.1:${port}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-test-'));
let server;
let cookie = '';
let tag; // 시험 계정의 해시. 이력의 작성자로 남는다

// 서버는 Rust 바이너리다(npm test 가 먼저 cargo build --release 를 돌린다). 임베딩 모델은 받지 않는다.
const bin = path.join('server', 'target', 'release', process.platform === 'win32' ? 'seesun-wiki.exe' : 'seesun-wiki');

// Node 판에서 만든 계정 : scrypt('password123', 'abcd') — 판을 바꿔도 로그인이 이어지는지 본다.
fs.writeFileSync(path.join(data, 'users.json'), JSON.stringify({ users: [{ id: 'old', name: '옛 계정', email: '', role: 'editor', salt: 'abcd',
  hash: '369653f98a00a3b2619d126e84ec4cdaa24dbc5fe2f4b850d53c1f5b3d943cb87574bb4d579822421da3a27159bf801bc44bd6958268da3f5af6403a889fe9d8',
  tokens: [], created: '2026-11-09T00:00:00.000Z' }] }, null, 2));

before(async () => {
  server = spawn(bin, [], { env: { ...process.env, WIKI_DATA: data, WIKI_PORT: String(port), WIKI_EMBED: 'off' }, stdio: 'pipe' });
  await new Promise((ok, no) => {
    server.stdout.on('data', (d) => String(d).includes('위키 :') && ok());
    server.stderr.on('data', (d) => no(new Error(String(d))));
  });
});
after(() => {
  server.kill();
  fs.rmSync(data, { recursive: true, force: true });
});

async function call(p, body, headers = {}) {
  const r = await fetch(B + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-wiki': '1', cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, json: await r.json() };
}

async function mcp(token, name, args) {
  const r = await fetch(`${B}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await r.json()).result;
}

const enc = encodeURIComponent;

test('로그인 없이는 쓸 수 없다', async () => {
  const r = await call('/api/page', { path: '산사태/개념/계류', title: '계류', body: 'x', base: null });
  assert.equal(r.status, 401);
});

test('Node 판에서 만든 계정으로 로그인한다', async () => {
  const r = await call('/api/login', { id: 'old', password: 'password123' });
  assert.equal(r.status, 200);
  // 옛 계정의 이름은 화면에 내지 않는다. 해시만 붙고 소속은 비어 있다.
  assert.equal(r.json.name, undefined);
  assert.match(r.json.tag, /^[0-9a-f]{6}$/);
  assert.equal(r.json.org, '');
  const bad = await call('/api/login', { id: 'old', password: 'wrong-password' });
  assert.equal(bad.status, 401);
  await call('/api/logout', {});
  cookie = '';
});

test('가입할 때 권한을 스스로 정하지 못한다', async () => {
  const r = await call('/api/signup', { id: 'sneaky', org: '부산본부', password: 'password123', role: 'admin' });
  assert.equal(r.status, 200);
  assert.equal(r.json.role, 'editor');
  await call('/api/logout', {});
  cookie = '';
});

test('관리자 계정으로 가입해 로그인한다', async () => {
  // 계정이 이미 있어 첫 가입자 규칙은 타지 않는다. 비상 창구(user admin)로 올린다.
  const none = await call('/api/signup', { id: 'tester', password: 'password123' });
  assert.equal(none.status, 400); // 소속 없이는 가입하지 못한다
  const odd = await call('/api/signup', { id: 'tester', org: '아무데나', password: 'password123' });
  assert.equal(odd.status, 400); // 목록 밖 소속도
  const r = await call('/api/signup', { id: 'tester', org: '김해본사', password: 'password123' });
  assert.equal(r.status, 200);
  tag = r.json.tag;
  const { execFileSync } = await import('node:child_process');
  execFileSync(bin, ['user', 'admin', 'tester'], { env: { ...process.env, WIKI_DATA: data } });
  const s = await call('/api/site');
  assert.equal(s.json.user.role, 'admin');
});

let commit;
test('소속을 바꾼다', async () => {
  const r = await call('/api/profile', { org: '대전본부' });
  assert.equal(r.json.org, '대전본부');
  assert.equal((await call('/api/profile', { org: '없는 곳' })).status, 400);
  const s = await call('/api/site');
  assert.equal(s.json.user.org, '대전본부');
  assert.deepEqual(s.json.orgs, ['김해본사', '서울본부', '대전본부', '부산본부']);
});

test('문서를 만들고 읽는다', async () => {
  const w = await call('/api/page', { path: '산사태/개념/계류', title: '계류', aliases: ['溪流'], body: '산골짜기를 흐르는 작은 물길이다. [[유출구]]로 나간다.', message: '처음 씀', base: null });
  assert.equal(w.status, 200);
  const r = await call(`/api/page?path=${enc('산사태/개념/계류')}`);
  assert.equal(r.json.kind, 'concept');
  assert.equal(r.json.summary, '산골짜기를 흐르는 작은 물길이다. 유출구로 나간다.');
  assert.deepEqual(r.json.links, { 유출구: null });
  commit = r.json.commit;
});

test('그 사이 바뀐 문서는 덮어쓰지 않는다', async () => {
  const r = await call('/api/page', { path: '산사태/개념/계류', title: '계류', body: '다른 본문', base: '0000000' });
  assert.equal(r.status, 409);
  const ok = await call('/api/page', { path: '산사태/개념/계류', title: '계류', aliases: ['溪流'], body: '산골짜기 물길이다.', message: '고침', base: commit });
  assert.equal(ok.status, 200);
  const h = await call(`/api/history?path=${enc('산사태/개념/계류')}`);
  assert.deepEqual(h.json.map((x) => [x.author, x.subject]), [[tag, '고침'], [tag, '처음 씀']]);
});

test('별칭으로 미리보기를 찾는다', async () => {
  const r = await call(`/api/preview?name=${enc('溪流')}`);
  assert.equal(r.json.title, '계류');
});

test('지난 판으로 되돌리면 새 커밋이 생긴다', async () => {
  const r = await call('/api/page/revert', { path: '산사태/개념/계류', rev: commit });
  assert.equal(r.status, 200);
  const p = await call(`/api/page?path=${enc('산사태/개념/계류')}`);
  assert.match(p.json.body, /유출구/);
  const h = await call(`/api/history?path=${enc('산사태/개념/계류')}`);
  assert.equal(h.json.length, 3);
});

test('MCP 로 읽고 쓰면 토큰 주인이 작성자다', async () => {
  const { json } = await call('/api/tokens', { label: '시험' });
  const read = await mcp(json.token, 'read_page', { name: '溪流' });
  assert.match(read.content[0].text, /개념\/계류/);
  const blind = await mcp(json.token, 'write_page', { path: '산사태/개념/계류', title: '계류', body: 'x', message: 'y' });
  assert.equal(blind.isError, true);
  const w = await mcp(json.token, 'write_page', { path: '산사태/개념/유출구', title: '유출구', body: '계곡이 산을 벗어나는 점이다.', message: 'MCP 시험', base_commit: null });
  assert.ok(!w.isError, w.content[0].text);
  const c = await call('/api/changes');
  assert.equal(c.json[0].author, tag);
  assert.equal(c.json[0].subject, 'MCP 시험 (MCP)');
  assert.deepEqual(c.json[0].files, ['산사태/개념/유출구']);
  // 표준에서 어긋나도 저장은 하고 경고를 준다. 쓰지 않는 말은 「용어 표준」의 표에서 읽는다 (절마다 표가 따로 있어도 모두).
  assert.ok(JSON.parse(w.content[0].text).warnings.some((x) => x.rule === 'section'));
  assert.equal((await mcp(json.token, 'style_guide', { topic: 'writing' })).isError, true); // 표준 문서가 아직 없다
  await call('/api/page', { path: '공통/매뉴얼/위키 사용법/글쓰기 표준', title: '글쓰기 표준', body: '## 문장\n\n- 한 문장에 사실 하나를 씁니다.\n', message: '처음 씀', base: null });
  assert.match((await mcp(json.token, 'style_guide', { topic: 'writing' })).content[0].text, /사실 하나/);
  await call('/api/page', { path: '공통/매뉴얼/위키 사용법/용어 표준', title: '용어 표준', body: '## 공통\n\n| 쓰지 않는 말 | 표준어 |\n|---|---|\n| 버그 | 오류 |\n\n## 산림\n\n| 쓰지 않는 말 | 표준어 |\n|---|---|\n| 溪流 · 계곡물길 | 계류 |\n', message: '처음 씀', base: null });
  assert.match((await mcp(json.token, 'style_guide', { topic: 'terms' })).content[0].text, /溪流/);
  const chk = await mcp(json.token, 'check_page', { path: '산사태/개념/새말', body: '## 정의\n\n- 溪流 옆의 땅입니다.\n\n## 관련\n' });
  assert.deepEqual(JSON.parse(chk.content[0].text).warnings.map((x) => x.rule).sort(), ['term', 'tone']);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const img = await mcp(json.token, 'upload_image', { data_base64: png.toString('base64'), format: 'png' });
  const { url } = JSON.parse(img.content[0].text);
  assert.equal((await fetch(`${B}${url}`)).status, 200);
  // 움직이는 도식(html) : 올릴 수 있고, 내보낼 때 격리 머리말이 붙는다 (2026.11.11)
  const html = '<!doctype html><title>t</title><canvas></canvas><script>1</script>';
  const anim = await mcp(json.token, 'upload_image', { data_base64: Buffer.from(html).toString('base64'), format: 'html' });
  const au = JSON.parse(anim.content[0].text).url;
  assert.match(au, /^\/assets\/[0-9a-f]+\.html$/);
  const ar = await fetch(`${B}${au}`);
  assert.match(ar.headers.get('content-type'), /text\/html/);
  assert.match(ar.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.doesNotMatch(ar.headers.get('content-security-policy'), /allow-same-origin/);
  assert.match(ar.headers.get('content-security-policy'), /connect-src 'none'/);
  // 스크롤바 스타일은 doctype 뒤 · 본문 앞에 끼운다 (2026.11.11)
  const served = await ar.text();
  assert.match(served, /^<!doctype html><style>[^<]*data-wiki-theme=dark[^<]*scrollbar-width:thin[^<]*<\/style><script>[^<]*wiki-theme[^<]*<\/script><title>t<\/title>/);
  assert.equal(served.replace(/<style>[^<]*<\/style><script>[^<]*<\/script>/, ''), html);
  assert.equal((await mcp(json.token, 'upload_image', { data_base64: 'eA==', format: 'svg' })).isError, true);
  // 자산 지우기 (2026.11.11) : 쓰는 문서가 있으면 거절 · 없으면 지우고 커밋 · 이름 밖으로는 못 나간다
  const pname = url.slice('/assets/'.length), aname = au.slice('/assets/'.length);
  await call('/api/page', { path: '산사태/그림 쓰는 문서', title: '그림 쓰는 문서', body: `![x](${url})\n*설명*\n`, message: '처음 씀', base: null });
  const unused = JSON.parse((await mcp(json.token, 'list_assets', { unused: true })).content[0].text).map((x) => x.name);
  assert.ok(unused.includes(aname) && !unused.includes(pname));
  const kept = await mcp(json.token, 'delete_asset', { name: pname });
  assert.equal(kept.isError, true);
  assert.match(kept.content[0].text, /그림 쓰는 문서/);
  assert.equal((await mcp(json.token, 'delete_asset', { name: '../pages/산사태/그림 쓰는 문서.md' })).isError, true);
  assert.equal((await mcp(json.token, 'delete_asset', { name: au })).isError, undefined);
  assert.equal((await fetch(`${B}${au}`)).status, 404);
  assert.equal((await fetch(`${B}${url}`)).status, 200);
  const listed = await (await fetch(`${B}/api/assets/list`)).json();
  assert.ok(listed.some((x) => x.name === pname && x.used_by.includes('산사태/그림 쓰는 문서')) && !listed.some((x) => x.name === aname));
  const anon = await fetch(`${B}/api/assets/delete`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wiki': '1' }, body: JSON.stringify({ name: pname }) });
  assert.equal(anon.status, 401);
  const bad = await fetch(`${B}/mcp`, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 401);
});

test('조사가 붙거나 띄어 써도 찾는다', async () => {
  await call('/api/page', { path: '산사태/개념/토석류', title: '토석류', body: '흙과 돌이 물과 섞여 계곡을 따라 빠르게 흘러내리는 현상이다. 유출구가 막히면 커진다.', message: '처음 씀', base: null });
  for (const q of ['유출구', '유출 구', '토석류가']) {
    const r = await call(`/api/search?q=${enc(q)}`);
    assert.ok(r.json.length, `「${q}」 결과 없음`);
  }
  const r = await call(`/api/search?q=${enc('토석류')}`);
  assert.equal(r.json[0].path, '산사태/개념/토석류');
  assert.match(r.json[0].snippet, /토석류|흙과 돌/);
  const none = await call(`/api/search?q=${enc('전혀없는말')}`);
  assert.equal(none.json.length, 0);
});

test('지운 경로에 새 문서를 다시 만든다', async () => {
  const d = await call('/api/page/delete', { path: '산사태/개념/토석류' });
  assert.equal(d.status, 200);
  const r = await call('/api/page', { path: '산사태/개념/토석류', title: '토석류', body: '다시 씀', base: null });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test('MCP 로 붙는다 (initialize · tools/list)', async () => {
  const { json } = await call('/api/tokens', { label: '목록' });
  const rpc = async (method, params) => (await fetch(`${B}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${json.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
  })).json();
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.match(init.result.instructions, /Seesun Wiki/);
  const list = await rpc('tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['check_page', 'delete_asset', 'find_mentions', 'list_assets', 'list_pages', 'page_history', 'read_page', 'read_revision', 'recent_changes', 'retrieve', 'search', 'style_guide', 'upload_image', 'write_page']);
});

test('바깥 경로는 막는다', async () => {
  const r = await call('/api/page', { path: '../밖', title: 'x', body: 'x', base: null });
  assert.equal(r.status, 400);
});

// ── 2026.11.09 리뷰 결함 · RAG 기반

test('그래프는 문서와 링크를 준다', async () => {
  const r = await call('/api/graph');
  assert.equal(r.status, 200);
  assert.ok(r.json.nodes.some((n) => n.id === '산사태/개념/계류' && n.kind === 'concept'));
  assert.ok(r.json.links.some((l) => l.source === '산사태/개념/계류' && l.target === '산사태/개념/유출구'));
});

test('근거 단락은 단락 앵커까지 붙은 주소를 준다', async () => {
  await call('/api/page', { path: '산사태/개념/사방댐', title: '사방댐', body: '계류를 가로질러 쌓은 낮은 둑이다.\n\n## 하는 일\n\n쓸려 내려오는 흙과 돌을 둑 뒤에 가둔다.\n\n## 관리 방법\n\n쌓인 흙은 준설로 걷어 낸다.', message: '처음 씀', base: null });
  const r = await call(`/api/retrieve?q=${enc('준설')}&k=3`);
  assert.equal(r.status, 200);
  assert.equal(r.json[0].path, '산사태/개념/사방댐');
  assert.equal(r.json[0].heading, '관리 방법');
  // 화면 주소(pageUrl · encodeURIComponent)와 같은 꼴, 앵커는 화면의 제목 id
  assert.equal(r.json[0].url, `/w/${enc('산사태')}/${enc('개념')}/${enc('사방댐')}#${enc('관리-방법')}`);
  assert.match(r.json[0].text, /준설/);
});

test('로그인 실패 제한은 한꺼번에 보내도 지킨다', async () => {
  const saved = cookie;
  const tries = await Promise.all(Array.from({ length: 20 }, () => fetch(`${B}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-wiki': '1' }, body: JSON.stringify({ id: 'old', password: 'wrong-password' }),
  })));
  const codes = tries.map((r) => r.status);
  assert.ok(codes.filter((c) => c === 401).length <= 10, codes.join(','));
  assert.ok(codes.includes(429), codes.join(','));
  cookie = saved;
});

test('막은 가입은 MCP 요청이 몰려도 막혀 있다', async () => {
  assert.equal((await call('/api/admin/settings', { openSignup: false })).status, 200);
  const { json } = await call('/api/tokens', { label: '부하' });
  const ping = () => fetch(`${B}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `bearer ${json.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  const signup = (i) => fetch(`${B}/api/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wiki': '1' }, body: JSON.stringify({ id: `crowd${i}`, org: '서울본부', password: 'password123' }) });
  const all = await Promise.all([...Array.from({ length: 40 }, ping), ...Array.from({ length: 40 }, (_, i) => signup(i))]);
  assert.ok(all.slice(0, 40).every((r) => r.status === 200), '소문자 bearer 도 받는다');
  assert.ok(all.slice(40).every((r) => r.status === 403), all.slice(40).map((r) => r.status).join(','));
  const s = await call('/api/site');
  assert.equal(s.json.needsSetup, false);
  assert.equal(s.json.user.id, 'tester');
  await call('/api/admin/settings', { openSignup: true });
});

test('MCP 는 묶음 요청 · URL-safe base64 를 받고, 모르는 토큰은 본문 전에 거른다', async () => {
  const { json } = await call('/api/tokens', { label: '묶음' });
  const post = (body, token = json.token) => fetch(`${B}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const batch = await (await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }])).json();
  assert.deepEqual(batch.map((m) => m.id), [1, 2]);
  // 끝 비트가 0 이 아닌 · 채움 없는 URL-safe 꼴 (Node 판 Buffer.from 이 받던 것)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64').toString('base64url');
  const img = await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'upload_image', arguments: { data_base64: png, format: 'png' } } })).json();
  assert.ok(!img.result.isError, img.result.content[0].text);
  const r = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'retrieve', arguments: { query: '준설' } } });
  assert.match((await r.json()).result.content[0].text, /#/);
  assert.equal((await post({ x: 'y'.repeat(1000) }, 'wk_nope')).status, 401);
});

// ── 2026.11.09 묶음 : 회사 업무 분야마다 문서를 나눈다 (<묶음>/<종류>/<이름>)

test('묶음 : 새 문서는 묶음부터 쓰고, 같은 이름은 묶음마다 따로 둔다', async () => {
  const bad = await call('/api/page', { path: '개념/새말', title: '새말', body: 'x', base: null });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /묶음/);
  await call('/api/page', { path: '하천/개념/계류', title: '계류', body: '하천에서 말하는 계류는 홍수 때 물길이다.', message: '처음 씀', base: null });
  await call('/api/page', { path: '하천/대문', title: '대문', body: '[[계류]] · [[사방댐]] · [[산사태/계류]]', message: '처음 씀', base: null });
  const front = await call(`/api/page?path=${enc('하천/대문')}`);
  assert.equal(front.json.links['계류'].path, '하천/개념/계류'); // 같은 묶음이 먼저
  assert.equal(front.json.links['사방댐'].path, '산사태/개념/사방댐'); // 다른 묶음에 하나뿐이면 그것
  assert.equal(front.json.links['산사태/계류'].path, '산사태/개념/계류'); // 묶음을 붙여 다른 묶음으로

  const site = await call(`/api/site?b=${enc('하천')}`);
  assert.equal(site.json.bundle, '하천');
  assert.equal(site.json.front, '하천/대문');
  assert.deepEqual(site.json.bundles.map((b) => b.name), ['산사태', '하천', '공통']);
  assert.ok(site.json.concepts.every((c) => ['하천', '공통'].includes(c.bundle)));
  assert.ok(site.json.manual.some((g) => g.bundle === '공통' && g.name === '위키 사용법')); // 공통 권은 어느 묶음에서나 보인다
  assert.equal((await call(`/api/site?b=${enc('없는묶음')}`)).json.bundle, '산사태');

  const s = await call(`/api/search?q=${enc('계류')}&b=${enc('하천')}`);
  assert.ok(s.json.length && s.json.every((h) => ['하천', '공통'].includes(h.bundle)), JSON.stringify(s.json.map((h) => h.path)));
  const all = await call(`/api/search?q=${enc('계류')}`);
  assert.ok(all.json.some((h) => h.bundle === '산사태') && all.json.some((h) => h.bundle === '하천'));

  const { json } = await call('/api/tokens', { label: '묶음' });
  const many = await mcp(json.token, 'read_page', { name: '계류' });
  assert.equal(many.isError, true);
  assert.match(many.content[0].text, /여러 묶음/);
  const one = await mcp(json.token, 'read_page', { name: '계류', bundle: '하천' });
  assert.equal(JSON.parse(one.content[0].text).path, '하천/개념/계류');
  const r = await mcp(json.token, 'retrieve', { query: '홍수 물길', bundle: '산사태' });
  assert.ok(JSON.parse(r.content[0].text).every((p) => !p.path.startsWith('하천/')));
});

test('묶음과 권 : 화면에서 만들고, 공유 묶음은 목록이 정한다', async () => {
  // 새 위키에도 공통은 공유 묶음으로 깔린다
  let list = await call('/api/bundles');
  assert.equal(list.json.find((b) => b.name === '공통').shared, true);

  assert.equal((await call('/api/bundle', { name: '개념', create: true })).status, 400); // 종류 이름은 못 쓴다
  assert.equal((await call('/api/bundle', { name: '하천', create: true })).status, 409); // 이미 있다
  assert.equal((await call('/api/bundle', { name: '안전', about: '현장 안전 수칙', create: true })).status, 200);
  assert.equal((await call('/api/volume', { bundle: '안전', name: '현장 점검', about: '점검 순서', order: 2, create: true })).status, 200);
  const site = await call(`/api/site?b=${enc('안전')}`);
  assert.equal(site.json.bundle, '안전'); // 문서가 없어도 묶음이 있다
  const vol = site.json.manual.find((g) => g.bundle === '안전' && g.name === '현장 점검');
  assert.ok(vol && vol.items.length === 0 && vol.about === '점검 순서'); // 빈 권도 차례에 보인다

  // 안전을 공유로 두면 하천에서도 안전 개념을 찾고, 공통을 풀면 하천에서 공통 개념이 빠진다
  await call('/api/page', { path: '안전/개념/안전모', title: '안전모', body: '머리를 지키는 모자다.', base: null });
  await call('/api/bundle', { name: '안전', about: '현장 안전 수칙', shared: true });
  await call('/api/bundle', { name: '공통', about: '', shared: false });
  const h = await call(`/api/site?b=${enc('하천')}`);
  assert.deepEqual(h.json.shared, ['안전']);
  assert.ok(h.json.concepts.some((c) => c.path === '안전/개념/안전모'));
  assert.ok(h.json.concepts.every((c) => c.bundle !== '공통'));
  await call('/api/bundle', { name: '공통', about: '', shared: true }); // 뒤 시험을 위해 되돌린다

  // 문서가 남은 묶음 · 권은 지우지 못한다
  assert.equal((await call('/api/bundle/delete', { name: '안전' })).status, 409);
  assert.equal((await call('/api/volume/delete', { bundle: '안전', name: '현장 점검' })).status, 200);
  list = await call('/api/bundles');
  assert.equal(list.json.find((b) => b.name === '안전').volumes.length, 0);

  // 모든 개념은 묶음을 가리지 않고, 쓴 사람의 소속을 단다
  const c = await call('/api/concepts');
  const hat = c.json.find((x) => x.path === '안전/개념/안전모');
  assert.ok(hat && Array.isArray(hat.orgs) && hat.orgs.length === 1, JSON.stringify(hat));
  assert.ok(c.json.some((x) => x.bundle === '하천') && c.json.some((x) => x.bundle === '산사태'));
});
