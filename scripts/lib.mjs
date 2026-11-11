// 스크립트 공통 : 위키 서버의 MCP(/mcp)를 부르는 창구와 머리말 읽기.
// 2026.11.09 : 서버가 Rust 로 바뀌어 서버 모듈을 직접 불러 쓸 수 없다. 스크립트는 모두 서버를 거쳐 쓴다
//              — 화면 · MCP 로 고친 것과 같은 이력(작성자 = 토큰 주인, 메시지 끝 「(MCP)」)이 남는다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONF = path.join(os.homedir(), '.wiki', 'config.json');

export function conf() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch {}
  return { url: process.env.WIKI_URL || c.url || 'http://127.0.0.1:4500', token: process.env.WIKI_TOKEN || c.token };
}

export function saveConf(c) {
  fs.mkdirSync(path.dirname(CONF), { recursive: true });
  fs.writeFileSync(CONF, JSON.stringify(c, null, 2), { mode: 0o600 });
}

export function die(msg) {
  console.error(msg);
  process.exit(1);
}

/** 서버 바이너리. 서버 PC 에서 계정 파일을 바로 고칠 때(login <계정>)만 쓴다. */
export function serverBin() {
  const bin = path.join(ROOT, 'server', 'target', 'release', process.platform === 'win32' ? 'seesun-wiki.exe' : 'seesun-wiki');
  if (!fs.existsSync(bin)) die(`서버 바이너리가 없습니다 (${bin}). 먼저 npm run build 를 돌리세요.`);
  return bin;
}

export function newToken(account, label) {
  try {
    return execFileSync(serverBin(), ['token', account, label], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    die(String(e.stderr || e.message).trim());
  }
}

/** MCP 도구를 부르고 글자 결과를 준다. 실패하면 끝낸다. */
export async function call(name, args) {
  const { url, token } = conf();
  if (!token) die('토큰이 없습니다. 먼저 `node scripts/wiki.mjs login <계정>` 을 실행하세요.');
  let r;
  try {
    r = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
  } catch {
    die(`위키 서버(${url})에 닿지 않습니다. 서버가 켜져 있는지 보세요.`);
  }
  if (r.status === 401) die('토큰이 맞지 않습니다. 다시 login 하세요.');
  const j = await r.json();
  if (j.error) die(j.error.message || JSON.stringify(j.error));
  const out = j.result.content.map((c) => c.text).join('\n');
  if (j.result.isError) die(out);
  return out;
}

// 문서 머리말 : 서버(server/src/frontmatter.rs)와 같은 작은 YAML.
//   key: 값 · key: [가, 나]
const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const unquote = (s) => s.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');

export function parse(text) {
  const m = text.match(FM);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
    else {
      v = unquote(v);
      if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    }
    meta[kv[1]] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}
