// oximemo 볼트의 개념 노트를 위키 「산사태/개념/」 문서로 가져온다.
//   node scripts/import-oximemo.mjs                 #산사태 태그가 달린 knowledge 노트 + 페이지/땅밀림
//   node scripts/import-oximemo.mjs <노트.md> ...    고른 노트만
// 이미 있는 문서는 덮어쓰지 않고 건너뛴다. 위키에서 고친 것을 볼트가 다시 덮으면 안 된다.
// 서버가 켜져 있고 login 해 둔 토큰이 있어야 한다. 서버를 거쳐 쓰므로 작성자는 토큰 주인이다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { call } from './lib.mjs';

const vault = process.env.OXIMEMO_VAULT || path.join(os.homedir(), '.oxi', 'spaces', 'personal', 'vault');

function front(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      if (v.startsWith('[')) {
        try { meta[key] = JSON.parse(v); } catch { meta[key] = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')); }
      } else meta[key] = v === '' ? [] : v.replace(/^["']|["']$/g, '');
    } else if (key && /^\s*-\s+/.test(line) && Array.isArray(meta[key])) {
      meta[key].push(line.replace(/^\s*-\s+/, '').replace(/^["']|["']$/g, ''));
    }
  }
  return { meta, body: text.slice(m[0].length) };
}

function pick() {
  const args = process.argv.slice(2);
  if (args.length) return args;
  const dir = path.join(vault, 'knowledge');
  const list = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f));
  const tagged = list.filter((f) => /^tags:\s*\n(\s*-\s*.*\n)*\s*-\s*산사태\s*$/m.test(fs.readFileSync(f, 'utf8')) || /tags:\s*\[[^\]]*산사태/.test(fs.readFileSync(f, 'utf8')));
  const extra = path.join(vault, '페이지', '땅밀림.md');
  return fs.existsSync(extra) ? [...tagged, extra] : tagged;
}

const have = new Set(JSON.parse(await call('list_pages', {})).map((p) => p.path));

for (const file of pick()) {
  const { meta, body } = front(fs.readFileSync(file, 'utf8'));
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  // 첫 줄 「# 제목」과 볼트 태그 줄은 위키에서 쓰지 않는다. 제목은 머리말로, 태그는 문서 종류(폴더)로 대신한다.
  const h1 = lines.findIndex((l) => /^#\s+/.test(l));
  const title = h1 >= 0 ? lines[h1].replace(/^#\s+/, '').trim() : path.basename(file, '.md');
  const rest = lines.filter((l, i) => i !== h1 && !/^#[^\s#][^\s]*(\s+#[^\s#][^\s]*)*\s*$/.test(l)).join('\n').trim();

  const p = `산사태/개념/${title}`; // #산사태 노트만 가져오므로 산사태 묶음에 둔다
  if (have.has(p)) {
    console.log(`건너뜀 (이미 있음) : ${p}`);
    continue;
  }

  let out = rest;
  for (const m of rest.matchAll(/oximg:\/\/([\w.-]+)/g)) {
    const src = path.join(vault, '_assets', m[1]);
    if (!fs.existsSync(src)) { console.warn(`그림 없음 : ${m[1]} (${title})`); continue; }
    // 서버가 내용 해시로 이름을 새로 짓는다. 본문 주소도 그 이름으로 바꾼다.
    const format = path.extname(m[1]).slice(1).toLowerCase().replace('jpeg', 'jpg');
    const { url } = JSON.parse(await call('upload_image', { data_base64: fs.readFileSync(src).toString('base64'), format }));
    out = out.replaceAll(m[0], url);
  }

  const aliases = (Array.isArray(meta.aliases) ? meta.aliases : []).filter((a) => a && a !== title);
  await call('write_page', { path: p, title, aliases, body: `${out}\n`, message: `${title} 를 oximemo 에서 가져옴`, base_commit: null });
  console.log(`가져옴 : ${p}`);
}
