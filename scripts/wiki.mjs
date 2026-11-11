// 위키 명령줄 창구. 서버의 MCP(/mcp)를 그대로 불러, 화면이나 MCP 로 고친 것과 같은 이력이 남는다.
// MCP 를 등록하지 않은 AI 세션 · 스크립트가 쓴다.
//
//   node scripts/wiki.mjs login <계정>                 서버 PC 에서 그 계정의 토큰을 만들어 저장한다
//   node scripts/wiki.mjs login --token <토큰> [--url <주소>]   화면에서 받은 토큰을 저장한다
//   node scripts/wiki.mjs search <말>
//   node scripts/wiki.mjs retrieve <질문> [--k N]               답의 근거가 될 단락과 인용 주소
//   node scripts/wiki.mjs list [concept|manual|page]
//   node scripts/wiki.mjs read <경로 · 제목 · 별칭> [--out <파일>]
//   node scripts/wiki.mjs write <경로> --file <md> -m <바꾼 것> (--base <commit> | --new) [--title T] [--aliases a,b] [--order N]
//   node scripts/wiki.mjs mentions <경로 · 제목>               이 문서 이름이 다른 문서에 링크 없이 나오는 곳
//   node scripts/wiki.mjs history <경로>
//   node scripts/wiki.mjs rev <경로> <hash>
//   node scripts/wiki.mjs recent [개수]
//   node scripts/wiki.mjs image <그림 파일>                   png · jpg · gif · webp · html(움직이는 도식)
//   node scripts/wiki.mjs assets [--unused]                    올린 자산 · 쓰는 문서 (--unused : 아무 문서도 안 쓰는 것만)
//   node scripts/wiki.mjs rm-asset <이름 · /assets/주소>        자산 지우기 (쓰는 문서가 있으면 거절 · 이력에는 남는다)
//   node scripts/wiki.mjs guide [writing|image]                글쓰기 · 그림 표준 (위키 문서)
//   node scripts/wiki.mjs check <경로> --file <md>             저장하지 않고 표준 검사
//
// 주소 · 토큰은 ~/.wiki/config.json 에 둔다. 환경변수 WIKI_URL · WIKI_TOKEN 이 있으면 그쪽이 먼저다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONF, call, conf, die, newToken, parse, saveConf } from './lib.mjs';

// 이름 붙은 옵션과 나머지 낱말을 나눈다. 값 없는 옵션은 --new 하나뿐이다.
function args(list) {
  const opt = {}, rest = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--new') opt.new = true;
    else if (a === '--unused') opt.unused = true;
    else if (a === '-m') opt.message = list[++i];
    else if (a.startsWith('--')) opt[a.slice(2)] = list[++i];
    else rest.push(a);
  }
  return { opt, rest };
}

const [cmd, ...raw] = process.argv.slice(2);
const { opt, rest } = args(raw);

if (cmd === 'login') {
  const c = conf();
  if (opt.url) c.url = opt.url.replace(/\/$/, '');
  if (opt.token) {
    c.token = opt.token;
  } else if (rest[0]) {
    // 서버와 같은 PC 에서만 된다. 서버 바이너리가 계정 파일에 바로 토큰을 더한다.
    c.token = newToken(rest[0], `명령줄 (${os.hostname()})`);
  } else {
    die('쓰는 법 : login <계정> | login --token <토큰> [--url <주소>]');
  }
  saveConf({ url: c.url, token: c.token });
  console.log(`저장함 : ${CONF} (${c.url})`);
} else if (cmd === 'search' && rest.length) {
  console.log(await call('search', { query: rest.join(' ') }));
} else if (cmd === 'retrieve' && rest.length) {
  console.log(await call('retrieve', { query: rest.join(' '), ...(opt.k ? { k: Number(opt.k) } : {}) }));
} else if (cmd === 'list') {
  console.log(await call('list_pages', rest[0] ? { kind: rest[0] } : {}));
} else if (cmd === 'read' && rest[0]) {
  const out = await call('read_page', { name: rest.join(' ') });
  if (opt.out) {
    // 원문은 파일로, 경로 · commit · 역링크만 화면에 낸다. 고친 뒤 그 파일을 그대로 write 에 넘긴다.
    const j = JSON.parse(out);
    fs.writeFileSync(opt.out, j.source);
    console.log(JSON.stringify({ path: j.path, commit: j.commit, backlinks: j.backlinks, saved: opt.out }, null, 2));
  } else {
    console.log(out);
  }
} else if (cmd === 'write' && rest[0]) {
  if (!opt.file) die('--file <본문 md> 가 필요합니다');
  if (!opt.message) die('-m <무엇을 바꿨는지> 가 필요합니다');
  if (!opt.base && !opt.new) die('이미 있는 문서면 --base <read 로 받은 commit>, 새 문서면 --new');
  // 파일에 머리말이 있으면 거기서 제목 · 별칭 · 순서를 읽는다. 옵션이 먼저다.
  const { meta, body } = parse(fs.readFileSync(opt.file, 'utf8'));
  const aliases = opt.aliases != null ? opt.aliases.split(',').map((s) => s.trim()).filter(Boolean) : Array.isArray(meta.aliases) ? meta.aliases : undefined;
  const order = opt.order != null ? Number(opt.order) : typeof meta.order === 'number' ? meta.order : undefined;
  console.log(await call('write_page', {
    path: rest[0],
    title: opt.title || meta.title || rest[0].split('/').pop(),
    body,
    ...(aliases ? { aliases } : {}),
    ...(order != null ? { order } : {}),
    message: opt.message,
    base_commit: opt.new ? null : opt.base,
  }));
} else if (cmd === 'mentions' && rest[0]) {
  // 이 문서 이름이 다른 문서에 링크 없이 나오는 곳. 고치지 않고 후보만 준다.
  console.log(await call('find_mentions', { name: rest.join(' ') }));
} else if (cmd === 'history' && rest[0]) {
  console.log(await call('page_history', { path: rest[0] }));
} else if (cmd === 'rev' && rest[1]) {
  console.log(await call('read_revision', { path: rest[0], rev: rest[1] }));
} else if (cmd === 'recent') {
  console.log(await call('recent_changes', rest[0] ? { limit: Number(rest[0]) } : {}));
} else if (cmd === 'image' && rest[0]) {
  const ext = path.extname(rest[0]).slice(1).toLowerCase().replace('jpeg', 'jpg');
  if (!['png', 'jpg', 'gif', 'webp', 'html'].includes(ext)) die('png · jpg · gif · webp 그림이나 html 도식만 올릴 수 있습니다');
  console.log(await call('upload_image', { data_base64: fs.readFileSync(rest[0]).toString('base64'), format: ext }));
} else if (cmd === 'assets') {
  console.log(await call('list_assets', { unused: !!opt.unused }));
} else if (cmd === 'rm-asset' && rest[0]) {
  console.log(await call('delete_asset', { name: rest[0] }));
} else if (cmd === 'guide') {
  console.log(await call('style_guide', { topic: rest[0] || 'writing' }));
} else if (cmd === 'check' && rest[0]) {
  if (!opt.file) die('--file <본문 md> 가 필요합니다');
  console.log(await call('check_page', { path: rest[0], body: parse(fs.readFileSync(opt.file, 'utf8')).body }));
} else {
  console.log('쓰는 법 : login · search · retrieve · list · read · write · check · guide · history · rev · recent · image · assets · rm-asset (머리말 주석 참고)');
}
